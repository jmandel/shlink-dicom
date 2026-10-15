// Whole-slide microscopy (VL Whole Slide Microscopy Image, modality SM): header parsing, the
// pyramid, and tile → frame → byte mapping.
//
// Pure TypeScript with no DOM: runs in browsers, workers and Bun. The network side (record cache,
// walking fragment headers) is in wsi-source.ts.
import type { SeriesEntry } from "./bundle";

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
  /** TILED_SPARSE: per frame, the 1-based (column, row) of its top-left pixel in the total matrix. */
  planePositions: Int32Array | null;
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

/** The header was cut short: read at least `needBytes` from the instance start and parse again. */
export class NeedMoreBytes extends Error {
  constructor(readonly needBytes: number) {
    super(`DICOM header continues past the bytes read (need ${needBytes})`);
    this.name = "NeedMoreBytes";
  }
}

export class SlideHeaderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlideHeaderError";
  }
}

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const UNDEF = 0xffffffff;
const T = (g: number, e: number) => ((g << 16) | e) >>> 0;

const TAG = {
  ImageType: T(0x0008, 0x0008),
  SOPClass: T(0x0008, 0x0016),
  SOPInstance: T(0x0008, 0x0018),
  Modality: T(0x0008, 0x0060),
  DimOrgType: T(0x0020, 0x9311),
  Spp: T(0x0028, 0x0002),
  Photometric: T(0x0028, 0x0004),
  Planar: T(0x0028, 0x0006),
  Frames: T(0x0028, 0x0008),
  Rows: T(0x0028, 0x0010),
  Columns: T(0x0028, 0x0011),
  PixelSpacing: T(0x0028, 0x0030),
  BitsAllocated: T(0x0028, 0x0100),
  BitsStored: T(0x0028, 0x0101),
  HighBit: T(0x0028, 0x0102),
  PixelRep: T(0x0028, 0x0103),
  PixelMeasuresSeq: T(0x0028, 0x9110),
  TotalCols: T(0x0048, 0x0006),
  TotalRows: T(0x0048, 0x0007),
  PlanePosSlideSeq: T(0x0048, 0x021a),
  ColPos: T(0x0048, 0x021e),
  RowPos: T(0x0048, 0x021f),
  OpticalPaths: T(0x0048, 0x0302),
  FocalPlanes: T(0x0048, 0x0303),
  SharedFG: T(0x5200, 0x9229),
  PerFrameFG: T(0x5200, 0x9230),
  EOT: T(0x7fe0, 0x0001),
  EOTLengths: T(0x7fe0, 0x0002),
  PixelData: T(0x7fe0, 0x0010),
} as const;

/** VRs for implicit VR little endian, for the elements this reader interprets. */
const IMPLICIT_VR: Record<number, string> = {
  [TAG.ImageType]: "CS", [TAG.SOPClass]: "UI", [TAG.SOPInstance]: "UI", [TAG.Modality]: "CS",
  [TAG.DimOrgType]: "CS", [TAG.Spp]: "US", [TAG.Photometric]: "CS", [TAG.Planar]: "US", [TAG.Frames]: "IS",
  [TAG.Rows]: "US", [TAG.Columns]: "US", [TAG.PixelSpacing]: "DS", [TAG.BitsAllocated]: "US", [TAG.BitsStored]: "US",
  [TAG.HighBit]: "US", [TAG.PixelRep]: "US", [TAG.PixelMeasuresSeq]: "SQ", [TAG.TotalCols]: "UL", [TAG.TotalRows]: "UL",
  [TAG.PlanePosSlideSeq]: "SQ", [TAG.ColPos]: "SL", [TAG.RowPos]: "SL", [TAG.OpticalPaths]: "UL", [TAG.FocalPlanes]: "UL",
  [TAG.SharedFG]: "SQ", [TAG.PerFrameFG]: "SQ", [TAG.EOT]: "OV", [TAG.EOTLengths]: "OV", [TAG.PixelData]: "OB",
};

interface El {
  tag: number;
  vr: string;
  /** Value offset (absolute within the buffer). */
  vo: number;
  /** Value length (UNDEF for undefined). */
  len: number;
}

/**
 * Reads a whole-slide instance's header from the first bytes of its Part 10 file, up to and
 * including the Basic Offset Table item. Throws NeedMoreBytes when `bytes` stops short;
 * with `partial: true` it instead returns what it found, with `complete: false`.
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
    focalPlanes: 1, opticalPaths: 1, pixelSpacing: null, planePositions: null, extendedOffsets: null, extendedLengths: null,
    pixelDataValueOffset: -1, encapsulated: false, pixelDataLength: -1, basicOffsets: null, firstFragmentOffset: -1,
    complete: false, needBytes: 0,
  };
  const str = (vo: number, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[vo + i]);
    return s.replace(/[\0 ]+$/, "").replace(/^ +/, "");
  };
  const ascii2 = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1]);
  const need = (n: number) => {
    if (n > end) throw new NeedMoreBytes(n);
  };

  let explicit = true;
  const readEl = (p: number, isExplicit: boolean): El => {
    need(p + 8);
    const tag = ((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true)) >>> 0;
    if (tag >>> 16 === 0xfffe) return { tag, vr: "", vo: p + 8, len: dv.getUint32(p + 4, true) };
    if (isExplicit && /^[A-Z]{2}$/.test(ascii2(p + 4))) {
      const vr = ascii2(p + 4);
      if (LONG_VR.has(vr)) {
        need(p + 12);
        return { tag, vr, vo: p + 12, len: dv.getUint32(p + 8, true) };
      }
      return { tag, vr, vo: p + 8, len: dv.getUint16(p + 6, true) };
    }
    const len = dv.getUint32(p + 4, true);
    return { tag, vr: IMPLICIT_VR[tag] ?? (len === UNDEF ? "SQ" : "UN"), vo: p + 8, len };
  };

  /** Skips an undefined-length value (sequence or item) at p; returns the position after its delimiter. */
  const skipUndefined = (p: number, isExplicit: boolean): number => {
    for (;;) {
      const el = readEl(p, isExplicit);
      if (el.tag === 0xfffee0dd || el.tag === 0xfffee00d) return el.vo;
      if (el.tag === 0xfffee000) {
        p = el.len === UNDEF ? skipUndefined(el.vo, isExplicit) : el.vo + el.len;
        continue;
      }
      p = el.len === UNDEF ? skipUndefined(el.vo, isExplicit) : el.vo + el.len;
    }
  };

  /** Calls `fn(itemStart, itemEnd)` for each item of a sequence; returns the position after it. */
  const eachItem = (el: El, isExplicit: boolean, fn: (a: number, b: number) => void): number => {
    let p = el.vo;
    const stop = el.len === UNDEF ? Infinity : el.vo + el.len;
    while (p < stop) {
      const it = readEl(p, isExplicit);
      if (it.tag === 0xfffee0dd) return it.vo;
      if (it.tag !== 0xfffee000) throw new SlideHeaderError("malformed sequence");
      if (it.len === UNDEF) {
        const after = skipUndefined(it.vo, isExplicit);
        fn(it.vo, after - 8);
        p = after;
      } else {
        need(it.vo + it.len);
        fn(it.vo, it.vo + it.len);
        p = it.vo + it.len;
      }
    }
    return stop;
  };

  /** Walks the elements of a data set in [a, b), calling fn; nested sequences are skipped unless fn handles them. */
  const walk = (a: number, b: number, isExplicit: boolean, fn: (el: El) => boolean | void) => {
    let p = a;
    while (p < b) {
      const el = readEl(p, isExplicit);
      if (el.tag === 0xfffee00d) return;
      const handled = fn(el);
      if (handled) {
        p = el.len === UNDEF ? (handled as any as number) : el.vo + el.len;
        continue;
      }
      p = el.len === UNDEF ? skipUndefined(el.vo, isExplicit) : el.vo + el.len;
    }
  };

  const u16 = (el: El) => dv.getUint16(el.vo, true);
  const u32 = (el: El) => dv.getUint32(el.vo, true);
  const num = (el: El) => {
    if (el.vr === "US") return u16(el);
    if (el.vr === "UL") return u32(el);
    if (el.vr === "SL") return dv.getInt32(el.vo, true);
    if (el.vr === "SS") return dv.getInt16(el.vo, true);
    return Number(str(el.vo, el.len).split("\\")[0]);
  };
  const u64s = (el: El) => {
    const out: number[] = [];
    for (let i = 0; i + 8 <= el.len; i += 8) out.push(dv.getUint32(el.vo + i, true) + dv.getUint32(el.vo + i + 4, true) * 2 ** 32);
    return out;
  };

  // File meta (always explicit VR LE).
  let pos = 132;
  for (;;) {
    need(pos + 8);
    if (dv.getUint16(pos, true) !== 0x0002) break;
    const el = readEl(pos, true);
    need(el.vo + el.len);
    if (el.tag === T(0x0002, 0x0010)) h.transferSyntax = str(el.vo, el.len);
    pos = el.vo + el.len;
  }
  if (h.transferSyntax === "1.2.840.10008.1.2.1.99" || h.transferSyntax === "1.2.840.10008.1.2.2") {
    throw new SlideHeaderError(`transfer syntax ${h.transferSyntax} is not supported for slides`);
  }
  explicit = h.transferSyntax !== "1.2.840.10008.1.2";

  const top = (el: El): number | boolean | void => {
    const t = el.tag;
    if (t === TAG.PixelData) return;
    if (el.vr === "SQ" || el.len === UNDEF) {
      if (t === TAG.SharedFG) {
        return eachItem(el, explicit, (a, b) =>
          walk(a, b, explicit, (e) => {
            if (e.tag !== TAG.PixelMeasuresSeq) return;
            return eachItem(e, explicit, (a2, b2) =>
              walk(a2, b2, explicit, (e2) => {
                if (e2.tag === TAG.PixelSpacing) {
                  need(e2.vo + e2.len);
                  const v = str(e2.vo, e2.len).split("\\").map(Number);
                  if (v.length === 2 && v.every((x) => x > 0)) h.pixelSpacing = [v[0], v[1]];
                }
              }),
            ) as any;
          }),
        ) as any;
      }
      if (t === TAG.PerFrameFG && h.dimensionOrganization !== "TILED_FULL") {
        const pp: number[] = [];
        const after = eachItem(el, explicit, (a, b) => {
          let c = 0, r = 0;
          walk(a, b, explicit, (e) => {
            if (e.tag !== TAG.PlanePosSlideSeq) return;
            return eachItem(e, explicit, (a2, b2) =>
              walk(a2, b2, explicit, (e2) => {
                need(e2.vo + e2.len);
                if (e2.tag === TAG.ColPos) c = num(e2);
                else if (e2.tag === TAG.RowPos) r = num(e2);
              }),
            ) as any;
          });
          pp.push(c, r);
        });
        if (pp.some((x) => x !== 0)) h.planePositions = Int32Array.from(pp);
        return after;
      }
      return;
    }
    need(el.vo + el.len);
    switch (t) {
      case TAG.ImageType: h.imageType = str(el.vo, el.len).split("\\").map((s) => s.trim()); break;
      case TAG.SOPClass: h.sopClassUid = str(el.vo, el.len); break;
      case TAG.SOPInstance: h.sopInstanceUid = str(el.vo, el.len); break;
      case TAG.Modality: h.modality = str(el.vo, el.len); break;
      case TAG.DimOrgType: h.dimensionOrganization = str(el.vo, el.len); break;
      case TAG.Spp: h.samplesPerPixel = num(el); break;
      case TAG.Photometric: h.photometric = str(el.vo, el.len); break;
      case TAG.Planar: h.planarConfiguration = num(el); break;
      case TAG.Frames: h.numberOfFrames = num(el) || 1; break;
      case TAG.Rows: h.rows = num(el); break;
      case TAG.Columns: h.columns = num(el); break;
      case TAG.BitsAllocated: h.bitsAllocated = num(el); break;
      case TAG.BitsStored: h.bitsStored = num(el); break;
      case TAG.HighBit: h.highBit = num(el); break;
      case TAG.PixelRep: h.pixelRepresentation = num(el); break;
      case TAG.TotalCols: h.totalColumns = num(el); break;
      case TAG.TotalRows: h.totalRows = num(el); break;
      case TAG.OpticalPaths: h.opticalPaths = num(el) || 1; break;
      case TAG.FocalPlanes: h.focalPlanes = num(el) || 1; break;
      case TAG.EOT: h.extendedOffsets = u64s(el); break;
      case TAG.EOTLengths: h.extendedLengths = u64s(el); break;
    }
  };

  try {
    for (;;) {
      need(pos + 8);
      const el = readEl(pos, explicit);
      if (el.tag === TAG.PixelData) {
        h.pixelDataValueOffset = el.vo;
        if (el.len === UNDEF) {
          h.encapsulated = true;
          const bot = readEl(el.vo, explicit);
          if (bot.tag !== 0xfffee000) throw new SlideHeaderError("encapsulated Pixel Data without a Basic Offset Table item");
          h.firstFragmentOffset = bot.vo + bot.len;
          if (bot.len > 0) {
            need(bot.vo + bot.len);
            const offs: number[] = [];
            for (let i = 0; i < bot.len; i += 4) offs.push(dv.getUint32(bot.vo + i, true));
            h.basicOffsets = offs;
          }
        } else {
          h.pixelDataLength = el.len;
        }
        h.complete = true;
        break;
      }
      if (el.tag > TAG.PixelData) break;
      const r = top(el);
      pos = typeof r === "number" ? r : el.len === UNDEF ? skipUndefined(el.vo, explicit) : el.vo + el.len;
    }
  } catch (e) {
    if (!(e instanceof NeedMoreBytes) || !o.partial) throw e;
    h.needBytes = e.needBytes;
  }
  h.flavor = h.imageType[2] ?? "";
  if (!h.totalColumns) h.totalColumns = h.columns;
  if (!h.totalRows) h.totalRows = h.rows;
  return h;
}

// ------------------------------------------------------------------------------------- pyramid

export interface SlideLevel {
  /** Index of the instance in the series. */
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
  /** Frame of tile (tx, ty), or -1 when the tile is absent (TILED_SPARSE). */
  frameOf(tx: number, ty: number): number;
}

export interface Pyramid {
  /** Finest first. */
  levels: SlideLevel[];
  width: number;
  height: number;
  label: number | null;
  overview: number | null;
  thumbnail: number | null;
}

/** Builds the pyramid from the instances' headers (null for instances not read or not images). */
export function buildPyramid(headers: (SlideHeader | null)[]): Pyramid {
  const vols: { i: number; h: SlideHeader }[] = [];
  let label: number | null = null, overview: number | null = null, thumbnail: number | null = null;
  headers.forEach((h, i) => {
    if (!h || !h.rows || !h.columns) return;
    if (h.flavor === "LABEL") label ??= i;
    else if (h.flavor === "OVERVIEW") overview ??= i;
    else if (h.flavor === "THUMBNAIL") thumbnail ??= i;
    else vols.push({ i, h });
  });
  // One level per Total Pixel Matrix width; the first instance of each width wins (further
  // instances of a level, such as other focal planes or concatenations, are not used).
  vols.sort((a, b) => b.h.totalColumns - a.h.totalColumns || a.i - b.i);
  const levels: SlideLevel[] = [];
  for (const { i, h } of vols) {
    if (levels.length && levels[levels.length - 1].width === h.totalColumns) continue;
    levels.push(makeLevel(i, h, 1));
  }
  if (!levels.length) throw new SlideHeaderError("the series has no tiled image");
  const base = levels[0];
  for (const l of levels) l.downsample = base.width / l.width;
  return { levels, width: base.width, height: base.height, label, overview, thumbnail };
}

function makeLevel(instance: number, h: SlideHeader, downsample: number): SlideLevel {
  const across = Math.ceil(h.totalColumns / h.columns);
  const down = Math.ceil(h.totalRows / h.rows);
  let frameOf: (tx: number, ty: number) => number;
  const sparse = h.planePositions && h.dimensionOrganization !== "TILED_FULL";
  if (sparse) {
    // TILED_SPARSE: Plane Position (Slide) of each frame; the first frame at a position wins.
    const map = new Int32Array(across * down).fill(-1);
    const pp = h.planePositions!;
    for (let f = 0; f < pp.length / 2; f++) {
      const tx = Math.floor((pp[2 * f] - 1) / h.columns), ty = Math.floor((pp[2 * f + 1] - 1) / h.rows);
      if (tx >= 0 && ty >= 0 && tx < across && ty < down && map[ty * across + tx] < 0) map[ty * across + tx] = f;
    }
    frameOf = (tx, ty) => (tx < 0 || ty < 0 || tx >= across || ty >= down ? -1 : map[ty * across + tx]);
  } else {
    // TILED_FULL: row-major tiles (first focal plane and optical path come first).
    frameOf = (tx, ty) => {
      if (tx < 0 || ty < 0 || tx >= across || ty >= down) return -1;
      const f = ty * across + tx;
      return f < h.numberOfFrames ? f : -1;
    };
  }
  return {
    instance, header: h, width: h.totalColumns, height: h.totalRows, tileWidth: h.columns, tileHeight: h.rows,
    tilesAcross: across, tilesDown: down, downsample, frameOf,
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
}

/** A frame table from the header alone (EOT, BOT, or native pixel data), or null if walking is needed. */
export function frameTableFromHeader(h: SlideHeader, instanceLength: number): FrameTable | null {
  if (!h.complete) return null;
  if (!h.encapsulated) {
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

/** The fragments (item values) inside a frame's bytes, which start at an item header. */
function fragmentsOf(frameBytes: Uint8Array): Uint8Array[] {
  const dv = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  const out: Uint8Array[] = [];
  let p = 0;
  while (p + 8 <= frameBytes.byteLength) {
    const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
    if (g !== 0xfffe || e !== 0xe000 || len === UNDEF) break;
    if (p + 8 + len > frameBytes.byteLength) break;
    out.push(frameBytes.subarray(p + 8, p + 8 + len));
    p += 8 + len;
  }
  return out;
}

// ------------------------------------------------------------------------------------- one-frame files

/**
 * A minimal Part 10 file holding one frame, for the decoder: the image pixel attributes of the
 * instance with Number of Frames 1, and the frame's fragments (or native bytes).
 */
export function singleFrameFile(h: SlideHeader, frame: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const pad = (s: string, ch = " ") => (s.length % 2 ? s + ch : s);
  const el16 = (g: number, e: number, vr: string, value: Uint8Array) => {
    const b = new Uint8Array(8 + value.length);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, g, true);
    dv.setUint16(2, e, true);
    b[4] = vr.charCodeAt(0);
    b[5] = vr.charCodeAt(1);
    dv.setUint16(6, value.length, true);
    b.set(value, 8);
    return b;
  };
  const us = (v: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const ts = h.encapsulated ? h.transferSyntax : "1.2.840.10008.1.2.1";
  const tsEl = el16(0x0002, 0x0010, "UI", enc.encode(pad(ts, "\0")));
  const glen = new Uint8Array(4);
  new DataView(glen.buffer).setUint32(0, tsEl.length, true);
  const pre = new Uint8Array(132);
  pre.set([0x44, 0x49, 0x43, 0x4d], 128);
  parts.push(pre, el16(0x0002, 0x0000, "UL", glen), tsEl);
  parts.push(el16(0x0028, 0x0002, "US", us(h.samplesPerPixel)));
  parts.push(el16(0x0028, 0x0004, "CS", enc.encode(pad(h.photometric))));
  if (h.samplesPerPixel > 1) parts.push(el16(0x0028, 0x0006, "US", us(h.planarConfiguration)));
  parts.push(el16(0x0028, 0x0008, "IS", enc.encode("1 ")));
  parts.push(el16(0x0028, 0x0010, "US", us(h.rows)));
  parts.push(el16(0x0028, 0x0011, "US", us(h.columns)));
  parts.push(el16(0x0028, 0x0100, "US", us(h.bitsAllocated)));
  parts.push(el16(0x0028, 0x0101, "US", us(h.bitsStored)));
  parts.push(el16(0x0028, 0x0102, "US", us(h.highBit)));
  parts.push(el16(0x0028, 0x0103, "US", us(h.pixelRepresentation)));
  const pd = new Uint8Array(12);
  const pdv = new DataView(pd.buffer);
  pdv.setUint16(0, 0x7fe0, true);
  pdv.setUint16(2, 0x0010, true);
  pd[4] = 0x4f; // "O"
  pd[5] = h.bitsAllocated > 8 && !h.encapsulated ? 0x57 : 0x42; // "W" / "B"
  if (h.encapsulated) {
    pdv.setUint32(8, UNDEF, true);
    const bot = new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]);
    // The frame's bytes are already items; make sure they end on an item boundary.
    let items = frame;
    const frags = fragmentsOf(frame);
    const used = frags.reduce((a, f) => a + 8 + f.byteLength, 0);
    if (used !== frame.byteLength) items = frame.subarray(0, used);
    parts.push(pd, bot, items, new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]));
  } else {
    pdv.setUint32(8, frame.byteLength, true);
    parts.push(pd, frame);
  }
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
