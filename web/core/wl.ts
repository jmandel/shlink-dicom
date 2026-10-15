// Window presets by modality. The default window and every other part of the display transform
// are display.ts's displayPlan.
import type { DisplayModel } from "./display";

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
