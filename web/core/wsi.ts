// Whole-slide microscopy (VL Whole Slide Microscopy Image, modality SM): header parsing, the
// pyramid, and tile → frame → byte mapping.
//
// Pure TypeScript with no DOM: runs in browsers, workers and Bun. The network side (record cache,
// walking fragment headers) is in wsi-source.ts.
import type { SeriesEntry } from "./bundle";
import { NeedMoreBytes, parseDicomSync, T as dicomT, UNDEF, type DataSet } from "./dicom";
import { TS } from "./transfer-syntax";

const WSI_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.77.1.6";

/** True when a series holds a whole-slide image (by SOP Class or modality SM). */
export function isSlideSeries(s: SeriesEntry): boolean {
  return s.modality === "SM" || s.instances.some((i) => i.sopClass === WSI_SOP_CLASS);
}

// ------------------------------------------------------------------------------------- header

export interface SlideHeader {
  transferSyntax: string;
  sopClassUid: string;
  sopInstanceUid: string;
  modality: string;
  /** ImageType values, e.g. ["DERIVED", "PRIMARY", "VOLUME", "RESAMPLED"]. */
  imageType: string[];
  /** The third ImageType value: VOLUME, LABEL, OVERVIEW, THUMBNAIL (or "" when absent). */
  flavor: string;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  photometric: string;
  planarConfiguration: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  numberOfFrames: number;
  /** Total Pixel Matrix Columns / Rows; Columns / Rows for a single-frame image without them. */
  totalColumns: number;
  totalRows: number;
  /** TILED_FULL, TILED_SPARSE, or "" (treated as TILED_FULL when there are no plane positions). */
  dimensionOrganization: string;
  focalPlanes: number;
  opticalPaths: number;
  /** Pixel Spacing (mm, row then column) from the Shared Functional Groups, when present. */
  pixelSpacing: [number, number] | null;
  /** Per frame (Per-frame Functional Groups), the 1-based (column, row) of its top-left pixel in the total matrix. */
  planePositions: Int32Array | null;
  /** Per frame: Z Offset in Slide Coordinate System (µm), or null. */
  frameZ: Float64Array | null;
  /** Per frame: Optical Path Identifier, or null. */
  framePath: string[] | null;
  /** Per frame: Referenced Segment Number (segmentations), or null. */
  frameSegment: Int32Array | null;
  /** Shared Functional Groups: the instance's Z offset (µm) and optical path, when given there. */
  sharedZ: number | null;
  sharedPath: string | null;
  /** Optical Path Sequence items, in order. */
  paths: OpticalPathInfo[];
  /** Total Pixel Matrix Origin (mm, slide coordinates) and Image Orientation (Slide). */
  origin: [number, number] | null;
  orientation: number[] | null;
  /** Imaged Volume Width (mm), for Pixel Spacing when the Shared Functional Groups lack it. */
  imagedVolumeWidth: number | null;
  seriesInstanceUid: string;
  frameOfReferenceUid: string;
  /** Series named in the Referenced Series Sequence (annotations and segmentations). */
  referencedSeries: string[];
  /** Segmentations: BINARY or FRACTIONAL, the segments, and Maximum Fractional Value. */
  segmentationType: string;
  segments: SegmentInfo[];
  maxFractional: number;
  /** Extended Offset Table and Lengths (relative to the first fragment item after the BOT). */
  extendedOffsets: number[] | null;
  extendedLengths: number[] | null;
  /** Offset of the Pixel Data element's value within the instance, or -1 if not reached. */
  pixelDataValueOffset: number;
  /** Encapsulated (undefined-length Pixel Data). */
  encapsulated: boolean;
  /** Native Pixel Data length (encapsulated: -1). */
  pixelDataLength: number;
  /** Basic Offset Table entries, when non-empty and inside the bytes read. */
  basicOffsets: number[] | null;
  /** Offset within the instance of the first fragment item after the BOT (encapsulated), or -1. */
  firstFragmentOffset: number;
  /** True when the parse reached Pixel Data (and, if encapsulated, past the BOT item). */
  complete: boolean;
  /** When not complete: bytes from the instance start needed to parse further. */
  needBytes: number;
}

export interface OpticalPathInfo {
  id: string;
  description: string;
  /** Illumination Wave Length (nm), when given. */
  wavelength: number | null;
  /** ICC Profile bytes (a copy), when given. */
  icc: Uint8Array | null;
}

export interface SegmentInfo {
  number: number;
  label: string;
  /** Recommended Display CIELab Value (DICOM 16-bit scaled), when given. */
  lab: [number, number, number] | null;
}

export { NeedMoreBytes };

export class SlideHeaderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlideHeaderError";
  }
}

const t = (g: number, e: number) => ((g << 16) | e) >>> 0;
const TAG = {
  ImageType: t(0x0008, 0x0008),
  SOPClass: t(0x0008, 0x0016),
  SOPInstance: t(0x0008, 0x0018),
  Modality: t(0x0008, 0x0060),
  DimOrgType: t(0x0020, 0x9311),
  Spp: t(0x0028, 0x0002),
  Photometric: t(0x0028, 0x0004),
  Planar: t(0x0028, 0x0006),
  Frames: t(0x0028, 0x0008),
  Rows: t(0x0028, 0x0010),
  Columns: t(0x0028, 0x0011),
  PixelSpacing: t(0x0028, 0x0030),
  BitsAllocated: t(0x0028, 0x0100),
  BitsStored: t(0x0028, 0x0101),
  HighBit: t(0x0028, 0x0102),
  PixelRep: t(0x0028, 0x0103),
  PixelMeasuresSeq: t(0x0028, 0x9110),
  ICCProfile: t(0x0028, 0x2000),
  ReferencedSeriesSeq: t(0x0008, 0x1115),
  SeriesInstance: t(0x0020, 0x000e),
  FrameOfReference: t(0x0020, 0x0052),
  Wavelength: t(0x0022, 0x0055),
  XOffset: t(0x0040, 0x072a),
  YOffset: t(0x0040, 0x073a),
  ZOffset: t(0x0040, 0x074a),
  ImagedVolumeWidth: t(0x0048, 0x0001),
  OriginSeq: t(0x0048, 0x0008),
  OrientationSlide: t(0x0048, 0x0102),
  OpticalPathSeq: t(0x0048, 0x0105),
  OpticalPathId: t(0x0048, 0x0106),
  OpticalPathDesc: t(0x0048, 0x0107),
  OpticalPathIdSeq: t(0x0048, 0x0207),
  SegmentationType: t(0x0062, 0x0001),
  SegmentSeq: t(0x0062, 0x0002),
  SegmentNumber: t(0x0062, 0x0004),
  SegmentLabel: t(0x0062, 0x0005),
  SegmentIdSeq: t(0x0062, 0x000a),
  RefSegmentNumber: t(0x0062, 0x000b),
  SegmentLab: t(0x0062, 0x000d),
  MaxFractional: t(0x0062, 0x000e),
  TotalCols: t(0x0048, 0x0006),
  TotalRows: t(0x0048, 0x0007),
  PlanePosSlideSeq: t(0x0048, 0x021a),
  ColPos: t(0x0048, 0x021e),
  RowPos: t(0x0048, 0x021f),
  OpticalPaths: t(0x0048, 0x0302),
  FocalPlanes: t(0x0048, 0x0303),
  SharedFG: t(0x5200, 0x9229),
  PerFrameFG: t(0x5200, 0x9230),
  EOT: t(0x7fe0, 0x0001),
  EOTLengths: t(0x7fe0, 0x0002),
  PixelData: t(0x7fe0, 0x0010),
} as const;

/** Little-endian 64-bit values (Extended Offset Table). */
function u64s(raw: Uint8Array | null): number[] | null {
  if (!raw) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 8 <= raw.length; i += 8) out.push(dv.getUint32(i, true) + dv.getUint32(i + 4, true) * 2 ** 32);
  return out;
}

/** The functional group macros this reader uses, from one Shared or Per-frame item. */
function functionalGroups(item: DataSet) {
  const fg = { spacing: null as [number, number] | null, col: 0, row: 0, z: null as number | null, path: null as string | null, segment: null as number | null };
  for (const m of item.seq(TAG.PixelMeasuresSeq)) {
    const v = m.strs(TAG.PixelSpacing).map(Number);
    if (v.length === 2 && v.every((x) => x > 0)) fg.spacing = [v[0], v[1]];
  }
  for (const m of item.seq(TAG.PlanePosSlideSeq)) {
    if (m.get(TAG.ColPos)) fg.col = m.num(TAG.ColPos) ?? 0;
    if (m.get(TAG.RowPos)) fg.row = m.num(TAG.RowPos) ?? 0;
    if (m.get(TAG.ZOffset)) fg.z = Number(m.str(TAG.ZOffset) ?? "");
  }
  for (const m of item.seq(TAG.OpticalPathIdSeq)) if (m.get(TAG.OpticalPathId)) fg.path = m.str(TAG.OpticalPathId) ?? "";
  for (const m of item.seq(TAG.SegmentIdSeq)) if (m.get(TAG.RefSegmentNumber)) fg.segment = m.num(TAG.RefSegmentNumber);
  return fg;
}

/**
 * Reads a whole-slide instance's header from the first bytes of its Part 10 file, up to and
 * including the Basic Offset Table item, with the data set reader (dicom.ts). Throws
 * NeedMoreBytes when `bytes` stops short; with `partial: true` it instead returns what it found,
 * with `complete: false`.
 */
export function parseSlideHeader(bytes: Uint8Array, o: { partial?: boolean } = {}): SlideHeader {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  if (end < 132) throw new NeedMoreBytes(4096);
  if (dv.getUint32(128) !== 0x4449434d) throw new SlideHeaderError("not a DICOM Part 10 file");
  const h: SlideHeader = {
    transferSyntax: "", sopClassUid: "", sopInstanceUid: "", modality: "", imageType: [], flavor: "",
    rows: 0, columns: 0, samplesPerPixel: 1, photometric: "", planarConfiguration: 0, bitsAllocated: 8, bitsStored: 8,
    highBit: 7, pixelRepresentation: 0, numberOfFrames: 1, totalColumns: 0, totalRows: 0, dimensionOrganization: "",
    focalPlanes: 1, opticalPaths: 1, pixelSpacing: null, planePositions: null, frameZ: null, framePath: null, frameSegment: null,
    sharedZ: null, sharedPath: null, paths: [], origin: null, orientation: null, imagedVolumeWidth: null,
    seriesInstanceUid: "", frameOfReferenceUid: "", referencedSeries: [], segmentationType: "", segments: [], maxFractional: 0,
    extendedOffsets: null, extendedLengths: null,
    pixelDataValueOffset: -1, encapsulated: false, pixelDataLength: -1, basicOffsets: null, firstFragmentOffset: -1,
    complete: false, needBytes: 0,
  };
  const r = parseDicomSync(bytes, { untilPixelData: true, need: true });
  h.transferSyntax = r.meta.str(dicomT.TransferSyntaxUID) ?? "";
  if (h.transferSyntax === TS.Deflated || h.transferSyntax === TS.ExplicitBE) {
    throw new SlideHeaderError(`transfer syntax ${h.transferSyntax} is not supported for slides`);
  }
  const ds = r.ds;
  const str = (tg: number) => ds.str(tg) ?? "";
  const num = (tg: number, d: number) => ds.num(tg) ?? d;
  h.imageType = ds.strs(TAG.ImageType);
  if (!h.imageType.length && ds.get(TAG.ImageType)) h.imageType = [""];
  h.sopClassUid = str(TAG.SOPClass);
  h.sopInstanceUid = str(TAG.SOPInstance);
  h.modality = str(TAG.Modality);
  h.dimensionOrganization = str(TAG.DimOrgType);
  h.samplesPerPixel = num(TAG.Spp, 1);
  h.photometric = str(TAG.Photometric);
  h.planarConfiguration = num(TAG.Planar, 0);
  h.numberOfFrames = num(TAG.Frames, 1) || 1;
  h.rows = num(TAG.Rows, 0);
  h.columns = num(TAG.Columns, 0);
  h.bitsAllocated = num(TAG.BitsAllocated, 8);
  h.bitsStored = num(TAG.BitsStored, 8);
  h.highBit = num(TAG.HighBit, 7);
  h.pixelRepresentation = num(TAG.PixelRep, 0);
  h.totalColumns = num(TAG.TotalCols, 0);
  h.totalRows = num(TAG.TotalRows, 0);
  h.opticalPaths = num(TAG.OpticalPaths, 1) || 1;
  h.focalPlanes = num(TAG.FocalPlanes, 1) || 1;
  h.extendedOffsets = u64s(ds.raw(TAG.EOT));
  h.extendedLengths = u64s(ds.raw(TAG.EOTLengths));
  h.seriesInstanceUid = str(TAG.SeriesInstance);
  h.frameOfReferenceUid = str(TAG.FrameOfReference);
  if (ds.get(TAG.OrientationSlide)) h.orientation = ds.strs(TAG.OrientationSlide).map(Number);
  if (ds.get(TAG.ImagedVolumeWidth)) h.imagedVolumeWidth = ds.num(TAG.ImagedVolumeWidth);
  h.segmentationType = str(TAG.SegmentationType);
  h.maxFractional = num(TAG.MaxFractional, 0);
  for (const it of ds.seq(TAG.SharedFG)) {
    const fg = functionalGroups(it);
    if (fg.spacing) h.pixelSpacing = fg.spacing;
    if (fg.z !== null) h.sharedZ = fg.z;
    if (fg.path !== null) h.sharedPath = fg.path;
  }
  const perFrame = ds.seq(TAG.PerFrameFG);
  if (perFrame.length) {
    const pp: number[] = [], zs: number[] = [], ids: string[] = [], segs: number[] = [];
    let anyZ = false, anyPath = false, anySeg = false;
    for (const it of perFrame) {
      const fg = functionalGroups(it);
      pp.push(fg.col, fg.row);
      zs.push(fg.z ?? 0);
      ids.push(fg.path ?? "");
      segs.push(fg.segment ?? 0);
      anyZ ||= fg.z !== null;
      anyPath ||= fg.path !== null;
      anySeg ||= fg.segment !== null;
    }
    if (pp.some((x) => x !== 0)) h.planePositions = Int32Array.from(pp);
    if (anyZ) h.frameZ = Float64Array.from(zs);
    if (anyPath) h.framePath = ids;
    if (anySeg) h.frameSegment = Int32Array.from(segs);
  }
  for (const it of ds.seq(TAG.OpticalPathSeq)) {
    const icc = it.get(TAG.ICCProfile);
    h.paths.push({
      id: it.str(TAG.OpticalPathId) ?? "",
      description: it.str(TAG.OpticalPathDesc) ?? "",
      wavelength: it.get(TAG.Wavelength) ? it.num(TAG.Wavelength) : null,
      icc: icc ? it.raw(TAG.ICCProfile)!.slice() : null,
    });
  }
  for (const it of ds.seq(TAG.OriginSeq)) h.origin = [Number(it.str(TAG.XOffset) ?? ""), Number(it.str(TAG.YOffset) ?? "")];
  for (const it of ds.seq(TAG.SegmentSeq)) {
    const lab = it.nums(TAG.SegmentLab);
    h.segments.push({ number: it.num(TAG.SegmentNumber) ?? 0, label: it.str(TAG.SegmentLabel) ?? "", lab: lab.length >= 3 ? [lab[0], lab[1], lab[2]] : null });
  }
  for (const it of ds.seq(TAG.ReferencedSeriesSeq)) {
    const uid = it.str(TAG.SeriesInstance);
    if (uid) h.referencedSeries.push(uid);
  }
  let need = r.needBytes;
  if (!need && r.dataEnd >= 0) {
    // The Pixel Data element and, for encapsulated data, its Basic Offset Table item.
    const p = r.dataEnd;
    if (((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true)) >>> 0 === TAG.PixelData) {
      const explicit = h.transferSyntax !== TS.ImplicitLE;
      const long = explicit && /^[A-Z]{2}$/.test(String.fromCharCode(bytes[p + 4], bytes[p + 5]));
      const vo = p + (long ? 12 : 8);
      if (vo > end) need = vo;
      else {
        const len = dv.getUint32(vo - 4, true);
        h.pixelDataValueOffset = vo;
        if (len === UNDEF) {
          h.encapsulated = true;
          if (vo + 8 > end) need = vo + 8;
          else {
            if (dv.getUint16(vo, true) !== 0xfffe || dv.getUint16(vo + 2, true) !== 0xe000) throw new SlideHeaderError("encapsulated Pixel Data without a Basic Offset Table item");
            const botLen = dv.getUint32(vo + 4, true);
            h.firstFragmentOffset = vo + 8 + botLen;
            if (botLen > 0) {
              if (vo + 8 + botLen > end) need = vo + 8 + botLen;
              else {
                const offs: number[] = [];
                for (let i = 0; i < botLen; i += 4) offs.push(dv.getUint32(vo + 8 + i, true));
                h.basicOffsets = offs;
              }
            }
          }
        } else h.pixelDataLength = len;
        if (!need) h.complete = true;
      }
    }
  }
  if (need) {
    if (!o.partial) throw new NeedMoreBytes(need);
    h.needBytes = need;
  }
  h.flavor = h.imageType[2] ?? "";
  if (!h.totalColumns) h.totalColumns = h.columns;
  if (!h.totalRows) h.totalRows = h.rows;
  if (!h.pixelSpacing && h.imagedVolumeWidth && h.totalColumns) {
    const sp = h.imagedVolumeWidth / h.totalColumns;
    h.pixelSpacing = [sp, sp];
  }
  return h;
}

// ------------------------------------------------------------------------------------- pyramid

/** One frame of one instance. */
export interface FrameRef {
  instance: number;
  frame: number;
}

export interface SlideLevel {
  /** The level's first instance and its header (tile size and pixel attributes are per level). */
  instance: number;
  header: SlideHeader;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesAcross: number;
  tilesDown: number;
  /** Base-level pixels per pixel of this level (1 for the base). */
  downsample: number;
  /** The frame holding tile (tx, ty) of focal plane `plane` and optical path `path` (indices into the pyramid's lists), or null when absent. */
  frameRef(tx: number, ty: number, plane?: number, path?: number): FrameRef | null;
  /** True when this level has any frame for the plane and path. */
  has(plane: number, path: number): boolean;
}

/** An optical path (a fluorescence channel, or the one brightfield path), or a segment of a segmentation. */
export interface SlidePath {
  id: string;
  label: string;
  wavelength: number | null;
}

export interface Pyramid {
  /** Finest first. */
  levels: SlideLevel[];
  width: number;
  height: number;
  label: number | null;
  overview: number | null;
  thumbnail: number | null;
  /** Optical paths (or, for a segmentation, segments), in display order. */
  paths: SlidePath[];
  /** Focal planes, as Z offsets in µm when the files give them, else as plane numbers; ascending. */
  planes: number[];
  /** True when the planes are Z offsets in µm. */
  planesInMicrons: boolean;
  /** Single-sample (fluorescence, or segmentation) images. */
  monochrome: boolean;
  /** Pixel Spacing (mm) of the base level, origin and orientation, for placing overlays. */
  spacing: [number, number] | null;
  origin: [number, number] | null;
  orientation: number[] | null;
  frameOfReferenceUid: string;
  /** The first ICC profile among the optical paths, if any. */
  icc: Uint8Array | null;
}

/** What each instance holds: its paths and planes, and how its frames map to them. */
interface InstanceLayout {
  i: number;
  h: SlideHeader;
  /** Path ids in frame order (TILED_FULL), or every id the frames use (sparse). */
  pathIds: string[];
  /** Plane keys in frame order (TILED_FULL), as Z values or local indices. */
  planeKeys: number[];
}

/** Builds the pyramid from the instances' headers (null for instances not read or not images). */
export function buildPyramid(headers: (SlideHeader | null)[]): Pyramid {
  const vols: InstanceLayout[] = [];
  let label: number | null = null, overview: number | null = null, thumbnail: number | null = null;
  headers.forEach((h, i) => {
    if (!h || !h.rows || !h.columns) return;
    if (h.flavor === "LABEL") label ??= i;
    else if (h.flavor === "OVERVIEW") overview ??= i;
    else if (h.flavor === "THUMBNAIL") thumbnail ??= i;
    else vols.push(layoutOf(i, h));
  });
  if (!vols.length) throw new SlideHeaderError("the series has no tiled image");
  const isSeg = vols.some((v) => v.h.segments.length);

  // Paths: optical paths (or segments) in first-seen order; numeric ids sort numerically.
  const pathMeta = new Map<string, SlidePath>();
  for (const v of vols) {
    if (isSeg) for (const g of v.h.segments) if (!pathMeta.has(String(g.number))) pathMeta.set(String(g.number), { id: String(g.number), label: g.label || `Segment ${g.number}`, wavelength: null });
    for (const p of v.h.paths) if (!pathMeta.has(p.id)) pathMeta.set(p.id, { id: p.id, label: p.description || (p.id ? `Channel ${p.id}` : ""), wavelength: p.wavelength });
    for (const id of v.pathIds) if (!pathMeta.has(id)) pathMeta.set(id, { id, label: id ? (isSeg ? `Segment ${id}` : `Channel ${id}`) : "", wavelength: null });
  }
  let paths = [...pathMeta.values()].filter((p) => vols.some((v) => v.pathIds.includes(p.id)));
  if (paths.every((p) => /^\d+$/.test(p.id))) paths.sort((a, b) => Number(a.id) - Number(b.id));
  if (!paths.length) paths = [{ id: "", label: "", wavelength: null }];
  const pathIndex = new Map(paths.map((p, k) => [p.id, k]));

  // Planes: Z values when every instance gives them, else plane numbers.
  const planesInMicrons = vols.every((v) => v.h.frameZ || v.h.sharedZ !== null);
  const planes = [...new Set(vols.flatMap((v) => v.planeKeys))].sort((a, b) => a - b);
  const planeIndex = new Map(planes.map((z, k) => [z, k]));

  // Levels: one per Total Pixel Matrix width; every instance of that width contributes frames.
  const widths = [...new Set(vols.map((v) => v.h.totalColumns))].sort((a, b) => b - a);
  const levels = widths.map((w) => makeLevel(vols.filter((v) => v.h.totalColumns === w), pathIndex, planeIndex, paths.length, planes.length));
  const base = levels[0];
  for (const l of levels) l.downsample = base.width / l.width;
  const bh = base.header;
  return {
    levels, width: base.width, height: base.height, label, overview, thumbnail, paths, planes, planesInMicrons,
    monochrome: vols.every((v) => v.h.samplesPerPixel === 1),
    spacing: bh.pixelSpacing, origin: bh.origin, orientation: bh.orientation, frameOfReferenceUid: bh.frameOfReferenceUid,
    icc: vols.flatMap((v) => v.h.paths).find((p) => p.icc)?.icc ?? null,
  };
}

function layoutOf(i: number, h: SlideHeader): InstanceLayout {
  const sparse = h.dimensionOrganization !== "TILED_FULL" && h.planePositions;
  if (h.segments.length) {
    // Segmentations: segments play the part of optical paths.
    const ids = h.frameSegment ? [...new Set(Array.from(h.frameSegment, String))] : h.segments.map((g) => String(g.number));
    return { i, h, pathIds: ids, planeKeys: [h.sharedZ ?? 0] };
  }
  const pathIds = sparse && h.framePath ? [...new Set(h.framePath)] : h.paths.length ? h.paths.slice(0, Math.max(1, h.opticalPaths)).map((p) => p.id) : [h.sharedPath ?? ""];
  if (h.sharedPath !== null && pathIds.length === 1) pathIds[0] = h.sharedPath;
  let planeKeys: number[];
  if (sparse && h.frameZ) planeKeys = [...new Set(Array.from(h.frameZ))];
  else if (h.sharedZ !== null) planeKeys = [h.sharedZ];
  else planeKeys = Array.from({ length: Math.max(1, h.focalPlanes) }, (_, k) => k);
  return { i, h, pathIds, planeKeys };
}

/** The most tiles one level of a slide may have (2^22: a 4096 × 4096 grid). */
export const MAX_LEVEL_TILES = 1 << 22;

function makeLevel(insts: InstanceLayout[], pathIndex: Map<string, number>, planeIndex: Map<number, number>, nPaths: number, nPlanes: number): SlideLevel {
  const h = insts[0].h;
  const across = Math.ceil(h.totalColumns / h.columns);
  const down = Math.ceil(h.totalRows / h.rows);
  const tiles = across * down;
  // Each (plane, path) map is two Int32Arrays of this many tiles: a damaged or hostile header
  // could ask for gigabytes.
  if (!(Number.isSafeInteger(tiles) && tiles > 0 && tiles <= MAX_LEVEL_TILES)) {
    throw new Error(`A slide level of ${h.totalColumns} × ${h.totalRows} pixels in ${h.columns} × ${h.rows} tiles is more than this viewer reads.`);
  }
  // One map per (plane, path): tile → instance and frame (-1 when absent).
  const maps = new Map<number, { inst: Int32Array; frame: Int32Array }>();
  const mapFor = (plane: number, path: number) => {
    const key = plane * nPaths + path;
    let m = maps.get(key);
    if (!m) maps.set(key, (m = { inst: new Int32Array(tiles).fill(-1), frame: new Int32Array(tiles).fill(-1) }));
    return m;
  };
  for (const v of insts) {
    const hh = v.h;
    const sparse = hh.dimensionOrganization !== "TILED_FULL" && hh.planePositions;
    if (sparse) {
      // TILED_SPARSE: each frame's Plane Position (Slide), Z offset and optical path (or segment).
      const pp = hh.planePositions!;
      for (let f = 0; f < pp.length / 2; f++) {
        const tx = Math.floor((pp[2 * f] - 1) / hh.columns), ty = Math.floor((pp[2 * f + 1] - 1) / hh.rows);
        if (tx < 0 || ty < 0 || tx >= across || ty >= down) continue;
        const pathId = hh.frameSegment ? String(hh.frameSegment[f]) : hh.framePath ? hh.framePath[f] : v.pathIds[0];
        const planeKey = hh.frameZ ? hh.frameZ[f] : v.planeKeys[0];
        const pi = pathIndex.get(pathId), zi = planeIndex.get(planeKey);
        if (pi === undefined || zi === undefined) continue;
        const m = mapFor(zi, pi);
        if (m.frame[ty * across + tx] < 0) (m.inst[ty * across + tx] = v.i), (m.frame[ty * across + tx] = f);
      }
    } else {
      // TILED_FULL: column fastest, then row, then focal plane, then optical path (or segment).
      const per = tiles;
      v.pathIds.forEach((pid, pk) =>
        v.planeKeys.forEach((zk, zl) => {
          const pi = pathIndex.get(pid), zi = planeIndex.get(zk);
          if (pi === undefined || zi === undefined) return;
          const m = mapFor(zi, pi);
          const first = (pk * v.planeKeys.length + zl) * per;
          for (let t = 0; t < tiles && first + t < hh.numberOfFrames; t++) {
            if (m.frame[t] < 0) (m.inst[t] = v.i), (m.frame[t] = first + t);
          }
        }),
      );
    }
  }
  void nPlanes;
  return {
    instance: insts[0].i, header: h, width: h.totalColumns, height: h.totalRows, tileWidth: h.columns, tileHeight: h.rows,
    tilesAcross: across, tilesDown: down, downsample: 1,
    frameRef(tx, ty, plane = 0, path = 0) {
      if (tx < 0 || ty < 0 || tx >= across || ty >= down) return null;
      const m = maps.get(plane * nPaths + path);
      if (!m) return null;
      const f = m.frame[ty * across + tx];
      return f < 0 ? null : { instance: m.inst[ty * across + tx], frame: f };
    },
    has: (plane, path) => maps.has(plane * nPaths + path),
  };
}

/**
 * The level to draw at `scale` (canvas pixels per base-level pixel): the coarsest level that
 * still has at least one level pixel per canvas pixel, else the finest.
 */
export function levelForScale(p: Pyramid, scale: number): number {
  let best = 0;
  for (let k = 0; k < p.levels.length; k++) {
    if (p.levels[k].downsample * scale <= 1.0001) best = k;
  }
  return best;
}

// ------------------------------------------------------------------------------------- fragments

/** The transfer syntax marks each frame's first fragment with a codestream start marker. */
function frameStartTest(ts: string): ((b0: number, b1: number, b2: number, b3: number) => boolean) | null {
  if (/^1\.2\.840\.10008\.1\.2\.4\.(50|51|57|70|80|81)$/.test(ts)) return (a, b) => a === 0xff && b === 0xd8;
  if (/^1\.2\.840\.10008\.1\.2\.4\.(90|91|92|93|201|202|203)$/.test(ts)) {
    return (a, b, c, d) => (a === 0xff && b === 0x4f) || (a === 0 && b === 0 && c === 0 && d === 0x0c);
  }
  // JPEG XL: a bare codestream starts FF 0A; the container with its 12-byte signature box.
  if (/^1\.2\.840\.10008\.1\.2\.4\.(110|111|112)$/.test(ts)) {
    return (a, b, c, d) => (a === 0xff && b === 0x0a) || (a === 0 && b === 0 && c === 0 && d === 0x0c);
  }
  return null; // one fragment per frame (RLE, deflate image frames, and others)
}

/**
 * Progressive fragment-item walker for one encapsulated instance. Feed it consecutive plaintext
 * chunks; it records where each frame starts. Frames are found by their codestream start marker
 * where the transfer syntax has one, so frames split over several fragments are handled.
 */
export class FragmentWalker {
  /** Instance-relative offset of each frame's first item header. */
  readonly starts: number[] = [];
  /** Next item header to read (instance-relative). */
  pos: number;
  /** End of the last complete item seen. */
  lastItemEnd: number;
  done = false;
  private isStart: ReturnType<typeof frameStartTest>;

  constructor(
    readonly header: SlideHeader,
    readonly instanceLength: number,
  ) {
    if (!header.encapsulated || header.firstFragmentOffset < 0) throw new SlideHeaderError("not encapsulated");
    this.pos = header.firstFragmentOffset;
    this.lastItemEnd = this.pos;
    this.isStart = frameStartTest(header.transferSyntax);
  }

  /** Frames whose start is known and whose end is known too (the next start, or the end). */
  get knownFrames(): number {
    return this.done ? this.starts.length : Math.max(0, this.starts.length - 1);
  }

  /**
   * Consumes plaintext `buf` covering instance bytes [bufStart, bufStart + buf.length). Returns
   * the instance offset to read from next (this.pos), or -1 when the sequence delimiter was seen.
   */
  feed(buf: Uint8Array, bufStart: number): number {
    if (this.done) return -1;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const bufEnd = bufStart + buf.byteLength;
    while (this.pos >= bufStart && this.pos + 8 <= bufEnd) {
      const p = this.pos - bufStart;
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
      if (g !== 0xfffe || (e !== 0xe000 && e !== 0xe0dd)) throw new SlideHeaderError(`no fragment item at byte ${this.pos}`);
      if (e === 0xe0dd || len === UNDEF) {
        this.done = true;
        this.lastItemEnd = this.pos;
        return -1;
      }
      let start: boolean;
      if (this.isStart) {
        if (this.pos + 12 > bufEnd) break; // need the first value bytes to classify the fragment
        start = this.starts.length === 0 || this.isStart(buf[p + 8], buf[p + 9], buf[p + 10], buf[p + 11]);
      } else start = true;
      if (start) this.starts.push(this.pos);
      this.pos += 8 + len;
      this.lastItemEnd = this.pos;
    }
    if (this.pos >= this.instanceLength) this.done = true;
    return this.done ? -1 : this.pos;
  }

  /** Instance byte range [a, b) of frame k (items included), once known. */
  frameRange(k: number): [number, number] | null {
    if (k >= this.starts.length) return null;
    if (k + 1 < this.starts.length) return [this.starts[k], this.starts[k + 1]];
    return this.done ? [this.starts[k], this.lastItemEnd] : null;
  }
}

/** Where each frame's bytes are, when known without walking. */
export interface FrameTable {
  source: "extended-offset-table" | "basic-offset-table" | "native" | "walk";
  /** Instance byte range [a, b) of frame k (items included for encapsulated data). */
  range(k: number): [number, number] | null;
  /** Native 1-bit data: frames are packed back to back, so frame k may start at this bit of its first byte. */
  bitShift?(k: number): number;
}

/** A frame table from the header alone (EOT, BOT, or native pixel data), or null if walking is needed. */
export function frameTableFromHeader(h: SlideHeader, instanceLength: number): FrameTable | null {
  if (!h.complete) return null;
  if (!h.encapsulated) {
    if (h.bitsAllocated === 1) {
      const bits = h.rows * h.columns * h.samplesPerPixel;
      const base = h.pixelDataValueOffset;
      return {
        source: "native",
        range: (k) => (k < h.numberOfFrames ? [base + Math.floor((k * bits) / 8), base + Math.ceil(((k + 1) * bits) / 8)] : null),
        bitShift: (k) => (k * bits) % 8,
      };
    }
    const fb = (h.rows * h.columns * h.samplesPerPixel * h.bitsAllocated) / 8;
    if (!Number.isInteger(fb) || fb <= 0) return null;
    const base = h.pixelDataValueOffset;
    return { source: "native", range: (k) => (k < h.numberOfFrames ? [base + k * fb, base + (k + 1) * fb] : null) };
  }
  const first = h.firstFragmentOffset;
  // Pixel Data ends with an 8-byte sequence delimiter; anything after it is ignored when parsing items.
  const last = instanceLength - 8;
  if (h.extendedOffsets && h.extendedOffsets.length === h.numberOfFrames) {
    const off = h.extendedOffsets;
    return {
      source: "extended-offset-table",
      range: (k) => {
        if (k >= off.length) return null;
        const a = first + off[k];
        const b = k + 1 < off.length ? first + off[k + 1] : last;
        return [a, b];
      },
    };
  }
  if (h.basicOffsets && h.basicOffsets.length === h.numberOfFrames) {
    const off = h.basicOffsets;
    return {
      source: "basic-offset-table",
      range: (k) => (k < off.length ? [first + off[k], k + 1 < off.length ? first + off[k + 1] : last] : null),
    };
  }
  return null;
}
