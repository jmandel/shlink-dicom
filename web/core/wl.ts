// Window/level: presets by modality and the automatic default window.
import { frameOf, type DecodedImage } from "../../viewer-kit/src/index";
import { floatRange, imageRealWorld, realValue, type DisplayModel, type RealWorld } from "./display";

export interface WindowPreset {
  id: string;
  label: string;
  /** null: the automatic window for the image. */
  center: number | null;
  width: number | null;
  /** A VOI LUT from the header (index into DisplayModel.voiLuts) instead of a window. */
  lut?: number;
}

const AUTO: WindowPreset = { id: "auto", label: "Auto", center: null, width: null };

/**
 * Window choices: Auto, then the windows and VOI LUTs the header carries (with their
 * explanations), then for CT Soft tissue, Lung, Bone and Brain (Hounsfield units).
 */
export function presetsFor(modality: string | null | undefined, model?: DisplayModel | null): WindowPreset[] {
  const file: WindowPreset[] = [];
  if (model && (model.windows.length > 1 || model.voiLuts.length)) {
    model.windows.forEach((w, i) => file.push({ id: `file-${i}`, label: `${w.explanation} (file)`, center: w.center, width: w.width }));
  }
  model?.voiLuts.forEach((l, i) => file.push({ id: `lut-${i}`, label: `${l.explanation || `LUT ${i + 1}`} (file LUT)`, center: null, width: null, lut: i }));
  if (modality === "CT") {
    return [
      AUTO,
      ...file,
      { id: "soft", label: "Soft tissue", center: 40, width: 400 },
      { id: "lung", label: "Lung", center: -600, width: 1500 },
      { id: "bone", label: "Bone", center: 400, width: 1800 },
      { id: "brain", label: "Brain", center: 40, width: 80 },
    ];
  }
  return [AUTO, ...file];
}

/**
 * The window to show an image with first: the instance's own Window Center/Width (first value)
 * when present, else the 1st–99th percentile of the frame's rescaled values. Float images (real
 * values, any width above 0): the file's window, else the range its Real World Value Mapping
 * covers, else the data range.
 */
export function autoWindow(img: DecodedImage, frame = 0, rw: RealWorld | null = null): { center: number; width: number } {
  const pf = img.perFrame?.[frame];
  const c = pf?.windowCenter ?? img.windowCenter;
  const w = pf?.windowWidth ?? img.windowWidth;
  if (img.float) {
    if (c != null && w != null && w > 0) return { center: c, width: w };
    const f = { rescaleSlope: img.rescaleSlope, rescaleIntercept: img.rescaleIntercept };
    const r = rw && rw.first != null && rw.last != null ? { lo: realValue(rw.first, rw, f), hi: realValue(rw.last, rw, f) } : floatRange(img, rw ?? imageRealWorld(img));
    if (!r) return { center: 0, width: 1 };
    const lo = Math.min(r.lo, r.hi), hi = Math.max(r.lo, r.hi);
    return { center: (lo + hi) / 2, width: hi > lo ? hi - lo : Math.abs(lo) || 1 };
  }
  if (c != null && w != null && w >= 1) return { center: c, width: w };
  return percentileWindow(img, frame);
}

function percentileWindow(img: DecodedImage, frame = 0, lo = 0.01, hi = 0.99): { center: number; width: number } {
  if (img.samplesPerPixel !== 1) return { center: 127.5, width: 256 };
  const f = frameOf(img, frame);
  const d = f.data;
  const step = Math.max(1, Math.floor(d.length / 65536));
  const sample: number[] = [];
  for (let i = 0; i < d.length; i += step) sample.push(d[i]);
  sample.sort((a, b) => a - b);
  const m = f.rescaleSlope, b = f.rescaleIntercept;
  const a0 = sample[Math.floor(lo * (sample.length - 1))] * m + b;
  const a1 = sample[Math.floor(hi * (sample.length - 1))] * m + b;
  const low = Math.min(a0, a1), high = Math.max(a0, a1);
  return { center: (low + high) / 2, width: Math.max(1, high - low) };
}
