// Image geometry in patient coordinates (PS3.3 C.7.6.2): position, orientation and spacing of an
// image or of one frame of an enhanced multi-frame image (per-frame and shared functional groups).
// Used to place contours and segmentations, to calibrate measurements, and to build volumes.
import { T, type DataSet } from "./dicom";

export type Vec3 = [number, number, number];

export interface Geometry {
  /** Patient position of the centre of the first transmitted pixel (mm). */
  position: Vec3 | null;
  /** Direction cosines of the rows (along a row, increasing column) and columns. */
  row: Vec3 | null;
  col: Vec3 | null;
  /** Pixel spacing: [between rows (mm), between columns (mm)]. */
  spacing: [number, number] | null;
  /** Where the spacing comes from. */
  spacingSource: SpacingSource;
  sliceThickness: number | null;
}

export type SpacingSource =
  | "pixel-spacing" // Pixel Spacing in the patient (CT, MR, calibrated projection)
  | "imager-pixel-spacing" // at the detector (projection radiography): not corrected for magnification
  | "magnification-corrected" // Imager Pixel Spacing divided by the Estimated Radiographic Magnification Factor
  | "ultrasound-region" // Sequence of Ultrasound Regions physical deltas
  | "none";

function first(ds: DataSet, seqTag: number, frame: number | null): DataSet | null {
  const per = frame !== null ? ds.seq(T.PerFrameFunctionalGroupsSequence)[frame] : null;
  const fromPer = per?.seq(seqTag)[0];
  if (fromPer) return fromPer;
  return ds.seq(T.SharedFunctionalGroupsSequence)[0]?.seq(seqTag)[0] ?? null;
}

const vec3 = (v: number[], o = 0): Vec3 | null => (v.length >= o + 3 ? [v[o], v[o + 1], v[o + 2]] : null);

/** Geometry of an image, or of frame `frame` (0-based) of an enhanced multi-frame image. */
export function geometryOf(ds: DataSet, frame: number | null = null): Geometry {
  const pos = first(ds, T.PlanePositionSequence, frame);
  const ori = first(ds, T.PlaneOrientationSequence, frame);
  const meas = first(ds, T.PixelMeasuresSequence, frame);
  const iop = (ori ?? ds).nums(T.ImageOrientationPatient);
  const g: Geometry = {
    position: vec3((pos ?? ds).nums(T.ImagePositionPatient)),
    row: vec3(iop, 0),
    col: vec3(iop, 3),
    spacing: null,
    spacingSource: "none",
    sliceThickness: (meas ?? ds).num(0x00180050) ?? null,
  };
  const ps = (meas ?? ds).nums(T.PixelSpacing);
  if (ps.length >= 2 && ps[0] > 0 && ps[1] > 0) {
    g.spacing = [ps[0], ps[1]];
    g.spacingSource = "pixel-spacing";
    return g;
  }
  const ips = ds.nums(T.ImagerPixelSpacing);
  if (ips.length >= 2 && ips[0] > 0) {
    const mag = ds.num(T.EstimatedRadiographicMagnificationFactor);
    if (mag && mag > 0 && mag !== 1) {
      g.spacing = [ips[0] / mag, ips[1] / mag];
      g.spacingSource = "magnification-corrected";
    } else {
      g.spacing = [ips[0], ips[1]];
      g.spacingSource = "imager-pixel-spacing";
    }
    return g;
  }
  const us = ds.seq(T.SequenceOfUltrasoundRegions)[0];
  if (us) {
    // Physical Units X/Y 0x0003 = cm.
    const ux = us.num(0x00186024), uy = us.num(0x00186026);
    const dx = us.num(0x0018602c), dy = us.num(0x0018602e);
    if (ux === 3 && uy === 3 && dx && dy) {
      g.spacing = [Math.abs(dy) * 10, Math.abs(dx) * 10];
      g.spacingSource = "ultrasound-region";
    }
  }
  return g;
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export function normal(g: Geometry): Vec3 | null {
  return g.row && g.col ? cross(g.row, g.col) : null;
}

/** Patient point → [column, row] in pixels (centre of pixel 0 is 0,0) and distance from the plane (mm). */
export function patientToPixel(g: Geometry, p: Vec3): { x: number; y: number; dist: number } | null {
  if (!g.position || !g.row || !g.col || !g.spacing) return null;
  const d = sub(p, g.position);
  const n = cross(g.row, g.col);
  return { x: dot(d, g.row) / g.spacing[1], y: dot(d, g.col) / g.spacing[0], dist: dot(d, n) };
}

/** Pixel [column, row] → patient point. */
export function pixelToPatient(g: Geometry, x: number, y: number): Vec3 | null {
  if (!g.position || !g.row || !g.col || !g.spacing) return null;
  const [sr, sc] = g.spacing;
  return [
    g.position[0] + g.row[0] * x * sc + g.col[0] * y * sr,
    g.position[1] + g.row[1] * x * sc + g.col[1] * y * sr,
    g.position[2] + g.row[2] * x * sc + g.col[2] * y * sr,
  ];
}

/** Plain words for the source of a measurement's calibration. */
export function spacingSourceText(s: SpacingSource): string {
  switch (s) {
    case "pixel-spacing":
      return "Calibrated from Pixel Spacing";
    case "imager-pixel-spacing":
      return "Calibrated at the detector (Imager Pixel Spacing); not corrected for magnification";
    case "magnification-corrected":
      return "Calibrated from Imager Pixel Spacing and the estimated magnification";
    case "ultrasound-region":
      return "Calibrated from the ultrasound region";
    default:
      return "Not calibrated: lengths are in pixels";
  }
}
