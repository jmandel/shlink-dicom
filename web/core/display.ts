// The grayscale display pipeline of PS3.4 N.2 beyond a linear window: Modality LUT Sequence,
// VOI LUT Sequence, VOI LUT Function (LINEAR_EXACT, SIGMOID), Presentation LUT Shape, and the
// window presets stored in the header (every value, with its explanation).
//
// The renderer applies Rescale and a LINEAR window on the GPU. What it cannot do is done here:
//   - a Modality LUT Sequence maps stored values to new values once per image (CPU);
//   - a VOI LUT Sequence maps those to the output once per image (CPU, 8-bit frame);
//   - SIGMOID is computed per window (CPU, 8-bit frame); LINEAR_EXACT is a shifted LINEAR window.
import { frameOf, type DecodedImage, type Frame, type Samples } from "../../viewer-kit/src/index";
import { T, type DataSet } from "./dicom";

export interface Lut {
  /** First stored value mapped. */
  first: number;
  /** Output bits used (lutOutputBits: the descriptor's, corrected by the data). */
  bits: number;
  /** Output bits the descriptor declares. */
  declaredBits: number;
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
  /** Rescale Slope and Intercept from the header (per-frame groups first), when it has them. */
  rescale: { slope: number; intercept: number } | null;
  windows: WindowSetting[];
  voiLuts: Lut[];
  voiFunction: VoiFunction;
  /** Presentation LUT Shape from the image itself. */
  presentationShape: "IDENTITY" | "INVERSE" | null;
}

/**
 * Output depth of a LUT. PS3.3 C.11.1.1.1 (Modality LUT) and C.11.2.1.1.1 (VOI LUT): the
 * descriptor's third value is the bits per entry, so outputs span 0 … 2^n − 1. Writers get it
 * wrong both ways, and the data are what the image was made with:
 *   - data wider than declared (a maximum at or past 2^n): the bits the maximum needs;
 *   - declared much wider than the data (a maximum below 2^(n − 2); for example CR VOI LUTs
 *     declared 16 bits whose entries run 0 … 4095): the smallest of 8, 10, 12, 14 and 16 bits that
 *     holds the maximum. A maximum within two bits of the declared depth keeps the declared depth,
 *     so a LUT that simply does not reach full white is left alone.
 */
export function lutOutputBits(declared: number, max: number): number {
  const n = Math.min(16, Math.max(1, declared));
  const needed = max > 0 ? Math.ceil(Math.log2(max + 1)) : 1;
  if (needed > n) return Math.min(16, needed);
  if (max < 2 ** (n - 2)) return [8, 10, 12, 14, 16].find((d) => max < 2 ** d) ?? n;
  return n;
}

/**
 * A LUT item. Its descriptor: entries (0 means 65536), first value mapped, bits per entry
 * (PS3.3 C.11.1.1.1, C.11.2.1.1.1). The first value mapped is US or SS as the LUT's input is
 * unsigned or signed (`signedInput`). LUT Data: 16-bit words, or bytes when 8-bit entries are
 * packed two per word (or stored as OB).
 */
export function readLut(it: DataSet, explanationTag: number, signedInput = false): Lut | null {
  const desc = it.nums(T.LUTDescriptor);
  const raw = it.raw(T.LUTData);
  if (desc.length < 3 || !raw) return null;
  const entries = desc[0] === 0 ? 65536 : desc[0];
  const first = signedInput && desc[1] > 32767 ? desc[1] - 65536 : desc[1];
  const bits = desc[2];
  const el = it.get(T.LUTData)!;
  let data: Uint16Array | Uint8Array;
  if (el.vr === "OB" || (raw.length === entries && bits <= 8)) data = raw.slice();
  else {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    data = new Uint16Array(Math.min(entries, raw.length >> 1));
    for (let i = 0; i < data.length; i++) data[i] = dv.getUint16(2 * i, it.le);
  }
  let max = 0;
  for (const v of data) if (v > max) max = v;
  return { first, bits: lutOutputBits(bits, max), declaredBits: bits, data, explanation: it.str(explanationTag) ?? "" };
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
  // X-ray angiography and RF: the Modality LUT Sequence describes the pixel intensity
  // relationship (LOG to linear, for subtraction) and is not applied for display; dcmtk does the
  // same (dcm2img gives identical output with +M and -M on such a file).
  const sop = ds.str(T.SOPClassUID) ?? "";
  const xray = sop === "1.2.840.10008.5.1.4.1.1.12.1" || sop === "1.2.840.10008.5.1.4.1.1.12.2";
  const mod = xray ? undefined : ds.seq(T.ModalityLUTSequence)[0];
  // LUT inputs: stored values for the Modality LUT (signed by Pixel Representation); the
  // Modality LUT's or rescale's output for a VOI LUT (signed when that can go negative).
  const signedStored = ds.num(T.PixelRepresentation) === 1;
  const intercept = pvt.num(T.RescaleIntercept) ?? 0, slope = pvt.num(T.RescaleSlope) ?? 1;
  const signedModality = !mod && (signedStored || intercept < 0 || slope < 0);
  const fn = (voiSrc.str(T.VOILUTFunction) ?? "LINEAR").toUpperCase();
  const shape = ds.str(T.PresentationLUTShape)?.toUpperCase();
  return {
    modalityLut: mod ? readLut(mod, T.LUTExplanation, signedStored) : null,
    rescaleType: pvt.str(T.RescaleType) ?? (mod ? mod.str(T.ModalityLUTType) : null),
    rescale: pvt.num(T.RescaleSlope) != null || pvt.num(T.RescaleIntercept) != null ? { slope: pvt.num(T.RescaleSlope) ?? 1, intercept: pvt.num(T.RescaleIntercept) ?? 0 } : null,
    windows,
    voiLuts: ds.seq(T.VOILUTSequence).map((it) => readLut(it, T.LUTExplanation, signedModality)).filter(Boolean) as Lut[],
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
 * window (IDENTITY_WINDOW).
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

/**
 * The identity window for 8-bit frames made by applyVoiLut and applySigmoid: the LINEAR formula
 * (PS3.3 C.11.2.1.2.1) with centre 128 and width 256 maps each level x to x.
 */
export const IDENTITY_WINDOW = { center: 128, width: 256 };

/** LINEAR_EXACT as a LINEAR window: (x − c)/w + 0.5 is the LINEAR formula with c' = c + 0.5 and w' = w + 1. */
export function linearWindow(fn: VoiFunction, center: number, width: number): { center: number; width: number } {
  return fn === "LINEAR_EXACT" ? { center: center + 0.5, width: width + 1 } : { center, width };
}

// ------------------------------------------------------------------------------ the pipeline

/**
 * Which VOI to apply: "auto" is what the file's maker chose (its first window, else its first
 * VOI LUT, else a window over the frame's values); the others are a window (modality units), one
 * of the file's windows or VOI LUTs, or the frame's full range.
 */
export type VoiChoice =
  | { kind: "auto" }
  | { kind: "window"; center: number; width: number }
  | { kind: "file-window"; index: number }
  | { kind: "lut"; index: number }
  | { kind: "minmax" };

export interface DisplayPlan {
  /** What the renderer draws (after the Modality LUT; after the VOI too when it is a LUT or SIGMOID). */
  frame: Frame;
  /** The renderer's view: its LINEAR window and whether to invert (MONOCHROME1 the renderer inverts itself). */
  view: { windowCenter: number; windowWidth: number; invert: boolean };
  /** The VOI window in modality units, or null when a VOI LUT applies. */
  window: { center: number; width: number } | null;
  /** The VOI LUT applied (index in the model), or null. */
  lut: number | null;
  model: DisplayModel | null;
}

const modalityCache = new WeakMap<DecodedImage, Map<number, Frame>>();
const voiCache = new WeakMap<DecodedImage, Map<string, Frame>>();

function cached(map: WeakMap<DecodedImage, Map<any, Frame>>, img: DecodedImage, key: number | string, make: () => Frame): Frame {
  let m = map.get(img);
  if (!m) map.set(img, (m = new Map()));
  let f = m.get(key);
  if (!f) m.set(key, (f = make()));
  return f;
}

/** A window over a frame's values (after rescale): the 1st to 99th percentile, or the full range. */
function valueWindow(f: Frame, lo = 0.01, hi = 0.99): { center: number; width: number } {
  const d = f.data;
  const m = f.rescaleSlope, b = f.rescaleIntercept;
  if (lo === 0 && hi === 1) {
    // The full range: every value.
    let a = Infinity, z = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v < a) a = v;
      if (v > z) z = v;
    }
    const low = Math.min(a * m + b, z * m + b), high = Math.max(a * m + b, z * m + b);
    return { center: (low + high + 1) / 2, width: Math.max(1, high - low + 1) };
  }
  const step = Math.max(1, Math.floor(d.length / 65536));
  const sample: number[] = [];
  for (let i = 0; i < d.length; i += step) sample.push(d[i]);
  sample.sort((a, b) => a - b);
  const a0 = sample[Math.floor(lo * (sample.length - 1))] * m + b;
  const a1 = sample[Math.floor(hi * (sample.length - 1))] * m + b;
  const low = Math.min(a0, a1), high = Math.max(a0, a1);
  return { center: (low + high) / 2, width: Math.max(1, high - low) };
}

/**
 * The display transform of PS3.4 N.2 for one frame, in one place: Modality LUT (or rescale), VOI
 * (window with its function, or VOI LUT), Presentation LUT Shape; MONOCHROME1 is inverted by the
 * renderer. Every view of an image draws through this, so a file looks the same everywhere: the
 * viewer, its thumbnails, /share and How. `header` is the instance's data set (null only when
 * there is none); float pixel data are windowed in real values (LINEAR_EXACT).
 */
export function displayPlan(img: DecodedImage, k: number, header: DataSet | null, choice: VoiChoice = { kind: "auto" }): DisplayPlan {
  const enhanced = (header?.num(T.NumberOfFrames) ?? 1) > 1;
  const model = header ? displayModel(header, enhanced ? k : 0) : null;
  const invert = model?.presentationShape === "INVERSE" && img.photometric !== "MONOCHROME1";
  if (img.samplesPerPixel !== 1 || (img.palette && img.photometric === "PALETTE COLOR")) {
    return { frame: frameOf(img, k), view: { windowCenter: IDENTITY_WINDOW.center, windowWidth: IDENTITY_WINDOW.width, invert: false }, window: null, lut: null, model };
  }
  if (img.float) {
    const rw = (header ? realWorldOf(header, enhanced ? k : 0) : null) ?? imageRealWorld(img);
    const range = floatRange(img, rw);
    const frame = cached(modalityCache, img, k, () => floatFrame(frameOf(img, k), rw, range));
    let w: { center: number; width: number };
    if (choice.kind === "window") w = choice;
    else if (choice.kind === "minmax" || !(model?.windows.length || (img.windowWidth ?? 0) > 0)) {
      const r = rw && rw.first != null && rw.last != null && choice.kind !== "minmax" ? { lo: realValue(rw.first, rw, frame), hi: realValue(rw.last, rw, frame) } : range ?? { lo: 0, hi: 1 };
      const lo = Math.min(r.lo, r.hi), hi = Math.max(r.lo, r.hi);
      w = { center: (lo + hi) / 2, width: hi > lo ? hi - lo : Math.abs(lo) || 1 };
    } else {
      const fw = model?.windows[choice.kind === "file-window" ? choice.index : 0];
      w = fw ?? { center: img.perFrame?.[k]?.windowCenter ?? img.windowCenter!, width: img.perFrame?.[k]?.windowWidth ?? img.windowWidth! };
    }
    const e = linearWindow("LINEAR_EXACT", w.center, w.width);
    return { frame, view: { windowCenter: e.center, windowWidth: e.width, invert }, window: w, lut: null, model };
  }
  // Modality: the LUT Sequence, else Rescale (which the renderer applies).
  const mod = model?.modalityLut;
  // The header's rescale wins over what the decoder found (it may stop reading early).
  const rs = model?.rescale;
  const raw = rs ? { ...frameOf(img, k), rescaleSlope: rs.slope, rescaleIntercept: rs.intercept } : frameOf(img, k);
  const base = mod ? cached(modalityCache, img, k, () => applyModalityLut(raw, mod)) : raw;
  // VOI.
  let lutIndex: number | null = null;
  let w: { center: number; width: number } | null = null;
  if (choice.kind === "lut" && model?.voiLuts[choice.index]) lutIndex = choice.index;
  else if (choice.kind === "window") w = { center: choice.center, width: choice.width };
  else if (choice.kind === "file-window" && model?.windows[choice.index]) w = model.windows[choice.index];
  else if (choice.kind === "minmax") w = valueWindow(base, 0, 1);
  else if (choice.kind === "auto") {
    const pf = img.perFrame?.[k];
    const c = model?.windows[0]?.center ?? pf?.windowCenter ?? img.windowCenter;
    const wd = model?.windows[0]?.width ?? pf?.windowWidth ?? img.windowWidth;
    if (c != null && wd != null && wd >= 1) w = { center: c, width: wd };
    else if (model?.voiLuts.length) lutIndex = 0;
    else w = valueWindow(base);
  } else w = valueWindow(base);
  if (lutIndex !== null) {
    const lut = model!.voiLuts[lutIndex];
    const frame = cached(voiCache, img, `${k}/lut/${lutIndex}`, () => applyVoiLut(base, lut));
    return { frame, view: { windowCenter: IDENTITY_WINDOW.center, windowWidth: IDENTITY_WINDOW.width, invert }, window: null, lut: lutIndex, model };
  }
  const fn = model?.voiFunction ?? "LINEAR";
  if (fn === "SIGMOID") {
    // Recomputed per window: keep only the latest per frame.
    const key = `${k}/sig`;
    let m = voiCache.get(img);
    if (!m) voiCache.set(img, (m = new Map()));
    const prev = m.get(key) as (Frame & { sig?: string }) | undefined;
    const tag = `${w!.center}/${w!.width}`;
    const frame = prev?.sig === tag ? prev : Object.assign(applySigmoid(base, w!.center, w!.width), { sig: tag });
    m.set(key, frame);
    return { frame, view: { windowCenter: IDENTITY_WINDOW.center, windowWidth: IDENTITY_WINDOW.width, invert }, window: w, lut: null, model };
  }
  const e = linearWindow(fn, w!.center, w!.width);
  return { frame: base, view: { windowCenter: e.center, windowWidth: e.width, invert }, window: w, lut: null, model };
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
