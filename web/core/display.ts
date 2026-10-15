// The grayscale display pipeline of PS3.4 N.2 beyond a linear window: Modality LUT Sequence,
// VOI LUT Sequence, VOI LUT Function (LINEAR_EXACT, SIGMOID), Presentation LUT Shape, and the
// window presets stored in the header (every value, with its explanation).
//
// The renderer applies Rescale and a LINEAR window on the GPU. What it cannot do is done here:
//   - a Modality LUT Sequence maps stored values to new values once per image (CPU);
//   - a VOI LUT Sequence maps those to the output once per image (CPU, 8-bit frame);
//   - SIGMOID is computed per window (CPU, 8-bit frame); LINEAR_EXACT is a shifted LINEAR window.
import type { DecodedImage, Frame, Samples } from "../../viewer-kit/src/index";
import { T, type DataSet } from "./dicom";

export interface Lut {
  /** First stored value mapped. */
  first: number;
  /** Output bits (from the descriptor; corrected when the data are wider). */
  bits: number;
  data: Uint16Array | Int16Array | Uint8Array;
  explanation: string;
}

export interface WindowSetting {
  center: number;
  width: number;
  explanation: string;
}

export type VoiFunction = "LINEAR" | "LINEAR_EXACT" | "SIGMOID";

export interface DisplayModel {
  modalityLut: Lut | null;
  /** Rescale type (e.g. "HU", "US"), for the HUD. */
  rescaleType: string | null;
  windows: WindowSetting[];
  voiLuts: Lut[];
  voiFunction: VoiFunction;
  /** Presentation LUT Shape from the image itself. */
  presentationShape: "IDENTITY" | "INVERSE" | null;
}

function readLut(it: DataSet, explanationTag: number): Lut | null {
  const desc = it.nums(T.LUTDescriptor);
  const raw = it.raw(T.LUTData);
  if (desc.length < 3 || !raw) return null;
  const entries = desc[0] === 0 ? 65536 : desc[0];
  // First mapped value is US or SS depending on Pixel Representation; read it as signed when > 32767 and the data are signed.
  let first = desc[1];
  const bits = desc[2];
  const el = it.get(T.LUTData)!;
  let data: Uint16Array | Uint8Array;
  if (el.vr === "OB" || (raw.length === entries && bits <= 8)) data = raw.slice();
  else {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    data = new Uint16Array(Math.min(entries, raw.length >> 1));
    for (let i = 0; i < data.length; i++) data[i] = dv.getUint16(2 * i, it.le);
  }
  // Some writers store wider data than the descriptor says: trust the data's maximum.
  let max = 0;
  for (const v of data) if (v > max) max = v;
  const realBits = Math.max(bits, max ? Math.ceil(Math.log2(max + 1)) : 1);
  return { first, bits: Math.min(16, realBits), data, explanation: it.str(explanationTag) ?? "" };
}

/** What the header asks for, for frame `frame` (per-frame functional groups first). */
export function displayModel(ds: DataSet, frame = 0): DisplayModel {
  const per = ds.seq(T.PerFrameFunctionalGroupsSequence)[frame];
  const shared = ds.seq(T.SharedFunctionalGroupsSequence)[0];
  const fg = (t: number) => per?.seq(t)[0] ?? shared?.seq(t)[0] ?? null;
  const voiSrc = fg(T.FrameVOILUTSequence) ?? ds;
  const pvt = fg(T.PixelValueTransformationSequence) ?? ds;
  const centers = voiSrc.nums(T.WindowCenter), widths = voiSrc.nums(T.WindowWidth), expl = voiSrc.strs(T.WindowCenterWidthExplanation);
  const windows: WindowSetting[] = [];
  for (let i = 0; i < Math.min(centers.length, widths.length); i++) {
    if (widths[i] >= 1) windows.push({ center: centers[i], width: widths[i], explanation: expl[i] || `Window ${i + 1}` });
  }
  const mod = ds.seq(T.ModalityLUTSequence)[0];
  const fn = (voiSrc.str(T.VOILUTFunction) ?? "LINEAR").toUpperCase();
  const shape = ds.str(T.PresentationLUTShape)?.toUpperCase();
  return {
    modalityLut: mod ? readLut(mod, T.LUTExplanation) : null,
    rescaleType: pvt.str(T.RescaleType) ?? (mod ? mod.str(T.ModalityLUTType) : null),
    windows,
    voiLuts: ds.seq(T.VOILUTSequence).map((it) => readLut(it, T.LUTExplanation)).filter(Boolean) as Lut[],
    voiFunction: fn === "SIGMOID" ? "SIGMOID" : fn === "LINEAR_EXACT" ? "LINEAR_EXACT" : "LINEAR",
    presentationShape: shape === "INVERSE" ? "INVERSE" : shape === "IDENTITY" ? "IDENTITY" : null,
  };
}

const lutAt = (lut: Lut, v: number) => {
  const i = v - lut.first;
  return lut.data[i < 0 ? 0 : i >= lut.data.length ? lut.data.length - 1 : i];
};

/** The frame with the Modality LUT applied: output values in a 16-bit unsigned frame, rescale 1/0. */
export function applyModalityLut(f: Frame, lut: Lut): Frame {
  const out = new Uint16Array(f.data.length);
  for (let i = 0; i < out.length; i++) out[i] = lutAt(lut, f.data[i]);
  return { ...f, data: out, signed: false, bitsAllocated: 16, bitsStored: lut.bits, rescaleSlope: 1, rescaleIntercept: 0, palette: null };
}

/**
 * The frame with a VOI LUT applied (after rescale): an 8-bit frame to show with the identity
 * window (center 127.5, width 256).
 */
export function applyVoiLut(f: Frame, lut: Lut): Frame {
  const out = new Uint8Array(f.data.length);
  const scale = 255 / (2 ** lut.bits - 1);
  const m = f.rescaleSlope, b = f.rescaleIntercept;
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(lutAt(lut, Math.round(f.data[i] * m + b)) * scale);
  return { ...f, data: out, signed: false, bitsAllocated: 8, bitsStored: 8, rescaleSlope: 1, rescaleIntercept: 0, palette: null };
}

/** The frame through VOI LUT Function SIGMOID (PS3.3 C.11.2.1.3.1), as an 8-bit frame for the identity window. */
export function applySigmoid(f: Frame, center: number, width: number): Frame {
  const out = new Uint8Array(f.data.length);
  const m = f.rescaleSlope, b = f.rescaleIntercept, k = -4 / width;
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(255 / (1 + Math.exp(k * (f.data[i] * m + b - center))));
  return { ...f, data: out, signed: false, bitsAllocated: 8, bitsStored: 8, rescaleSlope: 1, rescaleIntercept: 0, palette: null };
}

/** The identity window for 8-bit frames made by applyVoiLut and applySigmoid. */
export const IDENTITY_WINDOW = { center: 127.5, width: 256 };

/** LINEAR_EXACT as a LINEAR window: (x − c)/w + 0.5 is the LINEAR formula with c' = c + 0.5 and w' = w + 1. */
export function linearWindow(fn: VoiFunction, center: number, width: number): { center: number; width: number } {
  return fn === "LINEAR_EXACT" ? { center: center + 0.5, width: width + 1 } : { center, width };
}

// ------------------------------------------------------------------------------ real-world values

/**
 * A Real World Value Mapping (PS3.3 C.7.6.16.2.11): real value = stored × slope + intercept, in
 * `units` (UCUM). `first`/`last` are the stored values it covers, when the file gives a range.
 */
export interface RealWorld {
  slope: number;
  intercept: number;
  label: string;
  units: string;
  unitsMeaning: string;
  first: number | null;
  last: number | null;
}

/** The first Real World Value Mapping for a frame: per-frame group, shared group, then top level. */
export function realWorldOf(ds: DataSet, frame = 0): RealWorld | null {
  const per = ds.seq(T.PerFrameFunctionalGroupsSequence)[frame]?.seq(T.RealWorldValueMappingSequence)[0];
  const shared = ds.seq(T.SharedFunctionalGroupsSequence)[0]?.seq(T.RealWorldValueMappingSequence)[0];
  const it = per ?? shared ?? ds.seq(T.RealWorldValueMappingSequence)[0];
  if (!it) return null;
  const u = it.code(T.MeasurementUnitsCodeSequence);
  // The range: Double Float (0040,9214/9213) for float data, else the integer pair (0040,9216/9211).
  const first = it.num(T.DoubleFloatRealWorldValueFirstValueMapped) ?? it.num(T.RealWorldValueFirstValueMapped);
  const last = it.num(T.DoubleFloatRealWorldValueLastValueMapped) ?? it.num(T.RealWorldValueLastValueMapped);
  return {
    slope: it.num(T.RealWorldValueSlope) ?? 1,
    intercept: it.num(T.RealWorldValueIntercept) ?? 0,
    label: it.str(T.LUTLabel) ?? "",
    units: u?.value ?? "",
    unitsMeaning: u?.meaning ?? "",
    first: first != null && last != null && last > first ? first : null,
    last: first != null && last != null && last > first ? last : null,
  };
}

/** The mapping the decoder reported (no range): for use before the header is read. */
export function imageRealWorld(img: DecodedImage): RealWorld | null {
  const m = img.realWorldValueMapping;
  if (!m) return null;
  return { slope: m.slope ?? 1, intercept: m.intercept ?? 0, label: m.label ?? "", units: m.units ?? "", unitsMeaning: m.unitsMeaning ?? "", first: null, last: null };
}

/** Units to print after a value: the UCUM code, nothing for unity ("1") or an annotation alone ("{0:1}"). */
export function unitText(units: string): string {
  return !units || units === "1" || /^\{[^}]*\}$/.test(units) ? "" : units;
}

/** A value for display: up to 4 significant digits, plain notation where it reads well. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "no value" : v > 0 ? "∞" : "−∞";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e5) return String(Number(v.toPrecision(4)));
  return v.toExponential(3).replace(/\.?0+e/, "e");
}

/** The real-world value of stored value v: through the mapping when there is one, else Rescale. */
export function realValue(v: number, rw: Pick<RealWorld, "slope" | "intercept"> | null, f: Pick<Frame, "rescaleSlope" | "rescaleIntercept">): number {
  return rw ? v * rw.slope + rw.intercept : v * f.rescaleSlope + f.rescaleIntercept;
}

/** Range of real values [lo, hi] of a float image's finite samples (null if it has none). */
export function floatRange(img: DecodedImage, rw: Pick<RealWorld, "slope" | "intercept"> | null): { lo: number; hi: number } | null {
  if (img.minValue == null || img.maxValue == null) return null;
  const f = { rescaleSlope: img.rescaleSlope, rescaleIntercept: img.rescaleIntercept };
  const a = realValue(img.minValue, rw, f), b = realValue(img.maxValue, rw, f);
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/**
 * A float frame as a 16-bit frame the renderers take: real values in [lo, hi] spread over stored
 * 1..65535, whose rescale gives the real value back (to 1/65534 of the range). NaN becomes 0,
 * just below the range; infinities clamp to its ends. Windows stay in real values.
 */
export function floatFrame(f: Frame, rw: Pick<RealWorld, "slope" | "intercept"> | null, range: { lo: number; hi: number } | null): Frame {
  const lo = range?.lo ?? 0, hi = range && range.hi > range.lo ? range.hi : lo + 1;
  const step = (hi - lo) / 65534;
  const out = new Uint16Array(f.data.length);
  const m = rw ? rw.slope : f.rescaleSlope, b = rw ? rw.intercept : f.rescaleIntercept;
  for (let i = 0; i < out.length; i++) {
    const x = f.data[i] * m + b;
    if (x !== x) continue;
    const q = Math.round((x - lo) / step) + 1;
    out[i] = q < 1 ? 1 : q > 65535 ? 65535 : q;
  }
  return { ...f, data: out, signed: false, bitsAllocated: 16, bitsStored: 16, rescaleSlope: step, rescaleIntercept: lo - step, palette: null };
}

/** A typed view of a frame's samples as numbers (for the CPU paths above). */
export type { Samples };
export type { DecodedImage };
