// Window/level: presets by modality and the automatic default window.
import { frameOf, type DecodedImage } from "../../viewer-kit/src/index";

export interface WindowPreset {
  id: string;
  label: string;
  /** null: the automatic window for the image. */
  center: number | null;
  width: number | null;
}

const AUTO: WindowPreset = { id: "auto", label: "Auto", center: null, width: null };

/** CT gets Soft tissue, Lung, Bone and Brain (Hounsfield units); other modalities get Auto. */
export function presetsFor(modality: string | null | undefined): WindowPreset[] {
  if (modality === "CT") {
    return [
      AUTO,
      { id: "soft", label: "Soft tissue", center: 40, width: 400 },
      { id: "lung", label: "Lung", center: -600, width: 1500 },
      { id: "bone", label: "Bone", center: 400, width: 1800 },
      { id: "brain", label: "Brain", center: 40, width: 80 },
    ];
  }
  return [AUTO];
}

/**
 * The window to show an image with first: the instance's own Window Center/Width (first value)
 * when present, else the 1st–99th percentile of the frame's rescaled values.
 */
export function autoWindow(img: DecodedImage, frame = 0): { center: number; width: number } {
  const pf = img.perFrame?.[frame];
  const c = pf?.windowCenter ?? img.windowCenter;
  const w = pf?.windowWidth ?? img.windowWidth;
  if (c != null && w != null && w >= 1) return { center: c, width: w };
  return percentileWindow(img, frame);
}

export function percentileWindow(img: DecodedImage, frame = 0, lo = 0.01, hi = 0.99): { center: number; width: number } {
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

/** Rescaled value range, for slider bounds. */
export function valueRange(img: DecodedImage): { min: number; max: number } {
  const m = img.rescaleSlope, b = img.rescaleIntercept;
  if (img.minValue == null || img.maxValue == null) return { min: 0, max: 2 ** img.bitsStored };
  const a = img.minValue * m + b, z = img.maxValue * m + b;
  return { min: Math.min(a, z), max: Math.max(a, z) };
}
