// Objects that refer to images: segmentations, RT structure sets, parametric maps, presentation
// states and key object selections. Each reader returns what the viewer needs to draw it on (or
// list it with) the images it refers to.
import { codeOf, T, tag, type Code, type DataSet } from "./dicom";
import { realWorldOf, type RealWorld } from "./display";
import { geometryOf, type Geometry, type Vec3 } from "./geometry";
import { dicomLabToSrgb } from "./icc";

export interface ImageRef {
  sopInstance: string;
  sopClass: string;
  /** 1-based frame numbers; empty means all frames. */
  frames: number[];
  series: string | null;
}

function refsIn(items: DataSet[], series: string | null = null): ImageRef[] {
  return items.map((r) => ({
    sopInstance: r.str(T.ReferencedSOPInstanceUID) ?? "",
    sopClass: r.str(T.ReferencedSOPClassUID) ?? "",
    frames: r.nums(T.ReferencedFrameNumber),
    series,
  }));
}

/** Series referenced through ReferencedSeriesSequence (SEG, PR, PMAP…). */
export function referencedSeries(ds: DataSet): { series: string; images: ImageRef[] }[] {
  return ds.seq(T.ReferencedSeriesSequence).map((s) => {
    const uid = s.str(T.SeriesInstanceUID) ?? "";
    return { series: uid, images: refsIn([...s.seq(T.ReferencedInstanceSequence), ...s.seq(T.ReferencedImageSequence)], uid) };
  });
}

const PALETTE: [number, number, number][] = [
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180],
  [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [170, 110, 40],
];
export const paletteColor = (k: number) => PALETTE[k % PALETTE.length];

// ----------------------------------------------------------------------------- segmentation

export interface Segment {
  number: number;
  label: string;
  type: Code | null;
  color: [number, number, number];
}

export interface SegFrame {
  /** 1-based segment number this frame belongs to. */
  segment: number;
  /** The source image this frame was derived from, when the object says so. */
  source: ImageRef | null;
  /** Plane position of the frame (patient coordinates), for matching by position. */
  position: Vec3 | null;
}

export interface Segmentation {
  kind: "BINARY" | "FRACTIONAL" | "LABELMAP";
  fractionalMax: number;
  segments: Segment[];
  frames: SegFrame[];
  rows: number;
  columns: number;
  frameOfReference: string | null;
  referenced: { series: string; images: ImageRef[] }[];
}

export function readSegmentation(ds: DataSet): Segmentation {
  const type = (ds.str(T.SegmentationType) ?? "BINARY").toUpperCase();
  const segments = ds.seq(T.SegmentSequence).map((s, k) => {
    const lab = s.nums(T.RecommendedDisplayCIELabValue);
    return {
      number: s.num(T.SegmentNumber) ?? k + 1,
      label: s.str(T.SegmentLabel) ?? `Segment ${k + 1}`,
      type: s.code(T.SegmentedPropertyTypeCodeSequence),
      color: lab.length === 3 ? dicomLabToSrgb([lab[0], lab[1], lab[2]]) : paletteColor(k),
    };
  });
  const n = ds.num(T.NumberOfFrames) ?? 1;
  const per = ds.seq(T.PerFrameFunctionalGroupsSequence);
  const frames: SegFrame[] = [];
  for (let f = 0; f < n; f++) {
    const fg = per[f];
    const segId = fg?.seq(T.SegmentIdentificationSequence)[0] ?? ds.seq(T.SharedFunctionalGroupsSequence)[0]?.seq(T.SegmentIdentificationSequence)[0];
    const deriv = fg?.seq(T.DerivationImageSequence)[0]?.seq(T.SourceImageSequence)[0];
    frames.push({
      segment: segId?.num(T.ReferencedSegmentNumber) ?? 1,
      source: deriv ? refsIn([deriv])[0] : null,
      position: geometryOf(ds, f).position,
    });
  }
  return {
    kind: type === "FRACTIONAL" ? "FRACTIONAL" : type === "LABELMAP" ? "LABELMAP" : "BINARY",
    fractionalMax: ds.num(T.MaximumFractionalValue) ?? 255,
    segments,
    frames,
    rows: ds.num(T.Rows) ?? 0,
    columns: ds.num(T.Columns) ?? 0,
    frameOfReference: ds.str(T.FrameOfReferenceUID),
    referenced: referencedSeries(ds),
  };
}

// ----------------------------------------------------------------------------- parametric map

export interface MapFrame {
  /** The source image this frame was derived from, when the object says so. */
  source: ImageRef | null;
  geometry: Geometry;
}

export interface ParametricMap {
  frames: MapFrame[];
  rows: number;
  columns: number;
  frameOfReference: string | null;
  referenced: { series: string; images: ImageRef[] }[];
  /** Real World Value Mapping of the first frame (label, units, range). */
  realWorld: RealWorld | null;
  /** The file's window (first Window Center/Width), real values. */
  window: { center: number; width: number } | null;
  /** Palette Color Lookup Table (256 RGBA entries) when the file carries one. */
  palette: Uint8Array | null;
}

export function readParametricMap(ds: DataSet): ParametricMap {
  const n = ds.num(T.NumberOfFrames) ?? 1;
  const per = ds.seq(T.PerFrameFunctionalGroupsSequence);
  const frames: MapFrame[] = [];
  for (let f = 0; f < n; f++) {
    const deriv = per[f]?.seq(T.DerivationImageSequence)[0]?.seq(T.SourceImageSequence)[0];
    frames.push({ source: deriv ? refsIn([deriv])[0] : null, geometry: geometryOf(ds, f) });
  }
  const voi = per[0]?.seq(T.FrameVOILUTSequence)[0] ?? ds.seq(T.SharedFunctionalGroupsSequence)[0]?.seq(T.FrameVOILUTSequence)[0] ?? ds;
  const c = voi.num(T.WindowCenter), w = voi.num(T.WindowWidth);
  return {
    frames,
    rows: ds.num(T.Rows) ?? 0,
    columns: ds.num(T.Columns) ?? 0,
    frameOfReference: ds.str(T.FrameOfReferenceUID),
    referenced: referencedSeries(ds),
    realWorld: realWorldOf(ds, 0),
    window: c != null && w != null && w > 0 ? { center: c, width: w } : null,
    palette: readPalette(ds),
  };
}

/** Palette Color Lookup Table (0028,1101–1103 descriptors, 1201–1203 data), resampled to 256 RGBA entries. */
function readPalette(ds: DataSet): Uint8Array | null {
  const chans = [0x1201, 0x1202, 0x1203].map((e, i) => {
    const desc = ds.nums(tag(0x0028, 0x1101 + i));
    const raw = ds.raw(tag(0x0028, e));
    if (desc.length < 3 || !raw) return null;
    const count = desc[0] || 65536, bits = desc[2];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const v = new Float64Array(count);
    for (let k = 0; k < count; k++) v[k] = bits === 8 && raw.length === count ? raw[k] : (2 * k + 1 < raw.length ? dv.getUint16(2 * k, ds.le) : 0) / (bits > 8 ? 257 : 1);
    return v;
  });
  if (chans.some((c) => !c)) return null;
  const out = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    for (let ch = 0; ch < 3; ch++) {
      const c = chans[ch]!;
      out[k * 4 + ch] = Math.round(c[Math.round((k * (c.length - 1)) / 255)]);
    }
    out[k * 4 + 3] = 255;
  }
  return out;
}

// ----------------------------------------------------------------------------- RT structure set

export interface Contour {
  type: string; // CLOSED_PLANAR, OPEN_PLANAR, POINT, OPEN_NONPLANAR
  /** x,y,z triples, patient coordinates (mm). */
  points: Float64Array;
  images: string[];
}

export interface Roi {
  number: number;
  name: string;
  color: [number, number, number];
  contours: Contour[];
}

export interface StructureSet {
  label: string;
  rois: Roi[];
  /** Series the contours were drawn on. */
  series: string[];
  frameOfReference: string | null;
}

export function readStructureSet(ds: DataSet): StructureSet {
  const names = new Map<number, string>();
  for (const r of ds.seq(T.StructureSetROISequence)) names.set(r.num(T.ROINumber) ?? -1, r.str(T.ROIName) ?? "");
  const rois: Roi[] = ds.seq(T.ROIContourSequence).map((rc, k) => {
    const num = rc.num(T.ReferencedROINumber) ?? k + 1;
    const col = rc.nums(T.ROIDisplayColor);
    return {
      number: num,
      name: names.get(num) || `Structure ${num}`,
      color: col.length === 3 ? [col[0], col[1], col[2]] : paletteColor(k),
      contours: rc.seq(T.ContourSequence).map((c) => ({
        type: c.str(T.ContourGeometricType) ?? "CLOSED_PLANAR",
        points: Float64Array.from(c.nums(T.ContourData)),
        images: c.seq(T.ContourImageSequence).map((i) => i.str(T.ReferencedSOPInstanceUID) ?? ""),
      })),
    };
  });
  const series: string[] = [];
  let frameOfReference: string | null = null;
  for (const f of ds.seq(T.ReferencedFrameOfReferenceSequence)) {
    frameOfReference ??= f.str(T.FrameOfReferenceUID);
    for (const st of f.seq(tag(0x3006, 0x0012))) for (const se of st.seq(tag(0x3006, 0x0014))) {
      const u = se.str(T.SeriesInstanceUID);
      if (u) series.push(u);
    }
  }
  return { label: ds.str(T.StructureSetLabel) ?? "", rois, series, frameOfReference };
}

// ----------------------------------------------------------------------------- presentation state

export type Units = "PIXEL" | "DISPLAY" | "MATRIX";

export interface PsText {
  text: string;
  box: { tl: [number, number]; br: [number, number]; units: Units } | null;
  anchor: { at: [number, number]; units: Units; visible: boolean } | null;
}

export interface PsGraphic {
  type: string; // POINT, POLYLINE, INTERPOLATED, CIRCLE, ELLIPSE
  points: number[];
  units: Units;
  filled: boolean;
}

export interface PsAnnotation {
  layer: string;
  /** Images it applies to; empty: every image the state applies to. */
  images: ImageRef[];
  texts: PsText[];
  graphics: PsGraphic[];
}

export interface PresentationState {
  label: string;
  description: string;
  /** Every image the state applies to. */
  images: ImageRef[];
  series: string[];
  voi: { center: number; width: number; images: ImageRef[] }[];
  presentationShape: string | null;
  annotations: PsAnnotation[];
  shutter: {
    shapes: string[];
    rect: { left: number; right: number; top: number; bottom: number } | null;
    circle: { cx: number; cy: number; r: number } | null;
    polygon: number[] | null;
    value: number | null;
  } | null;
  displayedArea: { tl: [number, number]; br: [number, number]; images: ImageRef[] }[];
  rotation: number;
  flip: boolean;
}

export function readPresentationState(ds: DataSet): PresentationState {
  const refs = referencedSeries(ds);
  const units = (v: string | null): Units => (v === "DISPLAY" ? "DISPLAY" : v === "MATRIX" ? "MATRIX" : "PIXEL");
  const shapes = ds.strs(T.ShutterShape);
  return {
    label: ds.str(T.ContentLabel) ?? "",
    description: ds.str(T.ContentDescription) ?? "",
    images: refs.flatMap((r) => r.images),
    series: refs.map((r) => r.series),
    voi: ds.seq(T.SoftcopyVOILUTSequence).map((v) => ({
      center: v.num(T.WindowCenter) ?? NaN,
      width: v.num(T.WindowWidth) ?? NaN,
      images: refsIn(v.seq(T.ReferencedImageSequence)),
    })).filter((v) => Number.isFinite(v.center) && Number.isFinite(v.width)),
    presentationShape: ds.str(T.PresentationLUTShape),
    annotations: ds.seq(T.GraphicAnnotationSequence).map((a) => ({
      layer: a.str(T.GraphicLayer) ?? "",
      images: refsIn(a.seq(T.ReferencedImageSequence)),
      texts: a.seq(T.TextObjectSequence).map((t) => {
        const tl = t.nums(T.BoundingBoxTopLeftHandCorner), br = t.nums(T.BoundingBoxBottomRightHandCorner), an = t.nums(T.AnchorPoint);
        return {
          text: t.str(T.UnformattedTextValue) ?? "",
          box: tl.length === 2 && br.length === 2 ? { tl: [tl[0], tl[1]] as [number, number], br: [br[0], br[1]] as [number, number], units: units(t.str(T.BoundingBoxAnnotationUnits)) } : null,
          anchor: an.length === 2 ? { at: [an[0], an[1]] as [number, number], units: units(t.str(T.AnchorPointAnnotationUnits)), visible: t.str(T.AnchorPointVisibility) === "Y" } : null,
        };
      }),
      graphics: a.seq(T.GraphicObjectSequence).map((g) => ({
        type: g.str(T.GraphicType) ?? "POLYLINE",
        points: g.nums(T.GraphicData),
        units: units(g.str(T.GraphicAnnotationUnits)),
        filled: g.str(T.GraphicFilled) === "Y",
      })),
    })),
    shutter: shapes.length
      ? {
          shapes,
          rect: shapes.includes("RECTANGULAR")
            ? { left: ds.num(T.ShutterLeftVerticalEdge) ?? 0, right: ds.num(T.ShutterRightVerticalEdge) ?? 0, top: ds.num(T.ShutterUpperHorizontalEdge) ?? 0, bottom: ds.num(T.ShutterLowerHorizontalEdge) ?? 0 }
            : null,
          circle: shapes.includes("CIRCULAR") ? { cy: ds.num(T.CenterOfCircularShutter, 0) ?? 0, cx: ds.num(T.CenterOfCircularShutter, 1) ?? 0, r: ds.num(T.RadiusOfCircularShutter) ?? 0 } : null,
          polygon: shapes.includes("POLYGONAL") ? ds.nums(T.VerticesOfThePolygonalShutter) : null,
          value: ds.num(T.ShutterPresentationValue),
        }
      : null,
    displayedArea: ds.seq(T.DisplayedAreaSelectionSequence).map((d) => {
      const tl = d.nums(T.DisplayedAreaTopLeftHandCorner), br = d.nums(T.DisplayedAreaBottomRightHandCorner);
      return { tl: [tl[0] ?? 1, tl[1] ?? 1] as [number, number], br: [br[0] ?? 1, br[1] ?? 1] as [number, number], images: refsIn(d.seq(T.ReferencedImageSequence)) };
    }),
    rotation: ds.num(T.ImageRotation) ?? 0,
    flip: ds.str(T.ImageHorizontalFlip) === "Y",
  };
}

/** Whether an image reference list covers an instance (and frame, 1-based). Empty list: everything. */
export function refersTo(list: ImageRef[], sop: string, frame = 1): boolean {
  if (!list.length) return true;
  return list.some((r) => r.sopInstance === sop && (!r.frames.length || r.frames.includes(frame)));
}

// ----------------------------------------------------------------------------- key objects

export interface KeyObjectSelection {
  title: Code | null;
  /** The note that explains the selection (TEXT item "Key Object Description"). */
  description: string;
  images: ImageRef[];
}

export function readKeyObjects(ds: DataSet): KeyObjectSelection {
  const series = new Map<string, string>();
  for (const st of ds.seq(T.CurrentRequestedProcedureEvidenceSequence))
    for (const se of st.seq(T.ReferencedSeriesSequence))
      for (const i of se.seq(T.ReferencedSOPSequence)) series.set(i.str(T.ReferencedSOPInstanceUID) ?? "", se.str(T.SeriesInstanceUID) ?? "");
  const images: ImageRef[] = [];
  let description = "";
  for (const item of ds.seq(T.ContentSequence)) {
    const vt = item.str(T.ValueType);
    if (vt === "TEXT") description ||= item.str(T.TextValue) ?? "";
    if (vt === "IMAGE" || vt === "COMPOSITE" || vt === "WAVEFORM") {
      const r = item.seq(T.ReferencedSOPSequence)[0];
      if (r) {
        const sop = r.str(T.ReferencedSOPInstanceUID) ?? "";
        images.push({ sopInstance: sop, sopClass: r.str(T.ReferencedSOPClassUID) ?? "", frames: r.nums(T.ReferencedFrameNumber), series: series.get(sop) ?? null });
      }
    }
  }
  return { title: ds.code(T.ConceptNameCodeSequence), description, images };
}

export { codeOf };
