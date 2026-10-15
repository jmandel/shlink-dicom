// Microscopy Bulk Simple Annotations (SOP Class 1.2.840.10008.5.1.4.1.1.91.1, modality ANN):
// parsing, conversion to base-level pixel coordinates, and a grid index for drawing what is on
// screen. Pure TypeScript, no DOM.
import { dicomLabToSrgb } from "./icc";

export const ANN_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.91.1";

export interface AnnotationGroup {
  number: number;
  label: string;
  /** POINT, POLYLINE, POLYGON, ELLIPSE or RECTANGLE. */
  graphicType: string;
  count: number;
  /** Base-level pixel coordinates, x then y for each point. */
  xy: Float64Array;
  /** Annotation k is points [starts[k], starts[k + 1]). */
  starts: Uint32Array;
  /** Recommended display colour, when given. */
  color: [number, number, number] | null;
  /** Per annotation: min x, min y, max x, max y. */
  bbox: Float32Array;
  /** Grid index over the base level: cell → annotations whose box touches it. */
  grid: { cell: number; cols: number; rows: number; cells: Uint32Array[] };
}

export interface BulkAnnotations {
  coordinateType: string;
  referencedSeries: string[];
  groups: AnnotationGroup[];
}

/** Slide geometry, to place 3D (slide coordinate) annotations on the base level. */
export interface SlideGeometry {
  width: number;
  height: number;
  spacing: [number, number] | null;
  origin: [number, number] | null;
  orientation: number[] | null;
}

const UNDEF = 0xffffffff;
const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);

interface El {
  tag: number;
  vr: string;
  vo: number;
  len: number;
}

/** A small explicit-VR-little-endian walker (annotation objects are always explicit VR LE). */
function reader(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (p: number): El => {
    const tag = ((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true)) >>> 0;
    if (tag >>> 16 === 0xfffe) return { tag, vr: "", vo: p + 8, len: dv.getUint32(p + 4, true) };
    const vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
    if (LONG_VR.has(vr)) return { tag, vr, vo: p + 12, len: dv.getUint32(p + 8, true) };
    return { tag, vr, vo: p + 8, len: dv.getUint16(p + 6, true) };
  };
  const skipUndefined = (p: number): number => {
    for (;;) {
      const e = read(p);
      if (e.tag === 0xfffee0dd || e.tag === 0xfffee00d) return e.vo;
      p = e.len === UNDEF ? skipUndefined(e.vo) : e.vo + e.len;
    }
  };
  /** Elements of [a, b) (or to an item delimiter); calls fn with each. */
  const elements = (a: number, b: number, fn: (e: El) => void): number => {
    let p = a;
    while (p < b) {
      const e = read(p);
      if (e.tag === 0xfffee00d) return e.vo;
      fn(e);
      p = e.len === UNDEF ? skipUndefined(e.vo) : e.vo + e.len;
    }
    return p;
  };
  /** Items of a sequence element. */
  const items = (e: El, fn: (a: number, b: number) => void) => {
    let p = e.vo;
    const stop = e.len === UNDEF ? bytes.length : e.vo + e.len;
    while (p < stop) {
      const it = read(p);
      if (it.tag === 0xfffee0dd) return;
      if (it.len === UNDEF) {
        const end = elements(it.vo, bytes.length, () => {});
        fn(it.vo, end);
        p = end;
      } else {
        fn(it.vo, it.vo + it.len);
        p = it.vo + it.len;
      }
    }
  };
  const text = (e: El) => {
    let s = "";
    for (let i = 0; i < e.len; i++) s += String.fromCharCode(bytes[e.vo + i]);
    return s.replace(/[\0 ]+$/, "").trim();
  };
  const copy = (e: El) => bytes.slice(e.vo, e.vo + e.len).buffer;
  return { dv, read, elements, items, text, copy };
}

/** Points per annotation for the graphic types that have no index list. */
const FIXED_POINTS: Record<string, number> = { POINT: 1, ELLIPSE: 4, RECTANGLE: 4 };

/**
 * Parses a whole annotation instance. 3D (slide coordinate) groups are placed on the base level
 * with the slide's geometry; 2D groups are already in base-level pixels.
 */
export function parseBulkAnnotations(bytes: Uint8Array, slide: SlideGeometry): BulkAnnotations {
  if (bytes.length < 132 || bytes[128] !== 0x44 || bytes[131] !== 0x4d) throw new Error("not a DICOM Part 10 file");
  const r = reader(bytes);
  let p = 132;
  while (r.dv.getUint16(p, true) === 0x0002) {
    const e = r.read(p);
    p = e.vo + e.len;
  }
  const out: BulkAnnotations = { coordinateType: "", referencedSeries: [], groups: [] };
  const raw: { number: number; label: string; type: string; count: number; f32?: ArrayBuffer; f64?: ArrayBuffer; index?: ArrayBuffer; lab: [number, number, number] | null; dims: number }[] = [];
  r.elements(p, bytes.length, (e) => {
    switch (e.tag) {
      case 0x006a0001: out.coordinateType = r.text(e); break;
      case 0x00081115:
        r.items(e, (a, b) => r.elements(a, b, (x) => { if (x.tag === 0x0020000e) out.referencedSeries.push(r.text(x)); }));
        break;
      case 0x006a0002:
        r.items(e, (a, b) => {
          const g = { number: 0, label: "", type: "", count: 0, lab: null as [number, number, number] | null, dims: 2 } as (typeof raw)[number];
          r.elements(a, b, (x) => {
            switch (x.tag) {
              case 0x0040a180: g.number = r.dv.getUint16(x.vo, true); break;
              case 0x006a0005: g.label = r.text(x); break;
              case 0x00700023: g.type = r.text(x); break;
              case 0x006a000c: g.count = r.dv.getUint32(x.vo, true); break;
              case 0x00660016: g.f32 = r.copy(x); break;
              case 0x00660022: g.f64 = r.copy(x); break;
              case 0x00660040: g.index = r.copy(x); break;
              case 0x0062000d: g.lab = [0, 2, 4].map((k) => r.dv.getUint16(x.vo + k, true)) as [number, number, number]; break;
            }
          });
          raw.push(g);
        });
        break;
    }
  });
  const dims = out.coordinateType === "3D" ? 3 : 2;
  const toPixel = dims === 3 ? slideToPixel(slide) : null;
  raw.forEach((g, gi) => {
    const src = g.f64 ? new Float64Array(g.f64) : g.f32 ? new Float32Array(g.f32) : null;
    if (!src) return;
    const npts = Math.floor(src.length / dims);
    const xy = new Float64Array(npts * 2);
    for (let i = 0; i < npts; i++) {
      if (toPixel) {
        const [c, rr] = toPixel(src[i * 3], src[i * 3 + 1]);
        xy[2 * i] = c;
        xy[2 * i + 1] = rr;
      } else {
        xy[2 * i] = src[i * 2];
        xy[2 * i + 1] = src[i * 2 + 1];
      }
    }
    let starts: Uint32Array;
    if (g.index) {
      // Long Primitive Point Index List: 1-based index of each annotation's first coordinate value.
      const ix = new Uint32Array(g.index);
      starts = new Uint32Array(ix.length + 1);
      for (let k = 0; k < ix.length; k++) starts[k] = (ix[k] - 1) / dims;
      starts[ix.length] = npts;
    } else {
      const per = FIXED_POINTS[g.type] ?? npts;
      const n = Math.floor(npts / per);
      starts = Uint32Array.from({ length: n + 1 }, (_, k) => k * per);
    }
    const count = starts.length - 1;
    const bbox = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = starts[k]; i < starts[k + 1]; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      bbox.set([x0, y0, x1, y1], k * 4);
    }
    out.groups.push({
      number: g.number || gi + 1,
      label: g.label || `Group ${gi + 1}`,
      graphicType: g.type,
      count,
      xy,
      starts,
      color: g.lab ? dicomLabToSrgb(g.lab) : null,
      bbox,
      grid: gridIndex(bbox, count, slide.width, slide.height),
    });
  });
  return out;
}

function gridIndex(bbox: Float32Array, count: number, width: number, height: number) {
  const cell = Math.max(256, Math.ceil(Math.max(width, height) / 128));
  const cols = Math.ceil(width / cell) + 1, rows = Math.ceil(height / cell) + 1;
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let k = 0; k < count; k++) {
    const c0 = Math.max(0, Math.floor(bbox[k * 4] / cell)), r0 = Math.max(0, Math.floor(bbox[k * 4 + 1] / cell));
    const c1 = Math.min(cols - 1, Math.floor(bbox[k * 4 + 2] / cell)), r1 = Math.min(rows - 1, Math.floor(bbox[k * 4 + 3] / cell));
    for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) lists[rr * cols + c].push(k);
  }
  return { cell, cols, rows, cells: lists.map((l) => Uint32Array.from(l)) };
}

/** Annotations of a group whose boxes touch base-level rectangle [x0, x1) × [y0, y1), each once. */
export function annotationsIn(g: AnnotationGroup, x0: number, y0: number, x1: number, y1: number): Uint32Array {
  const { cell, cols, rows, cells } = g.grid;
  const c0 = Math.max(0, Math.floor(x0 / cell)), r0 = Math.max(0, Math.floor(y0 / cell));
  const c1 = Math.min(cols - 1, Math.floor(x1 / cell)), r1 = Math.min(rows - 1, Math.floor(y1 / cell));
  const seen = new Uint8Array(g.count);
  const out: number[] = [];
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      for (const k of cells[r * cols + c]) {
        if (seen[k]) continue;
        seen[k] = 1;
        const b = k * 4;
        if (g.bbox[b + 2] >= x0 && g.bbox[b] <= x1 && g.bbox[b + 3] >= y0 && g.bbox[b + 1] <= y1) out.push(k);
      }
  return Uint32Array.from(out);
}

/**
 * Slide coordinates (mm) → base-level pixel (column, row): the inverse of
 * X = Ox + c·Δc·r1 + r·Δr·c1, Y = Oy + c·Δc·r2 + r·Δr·c2, with the row (r) and column (c) direction
 * cosines from Image Orientation (Slide) and the spacing from Pixel Spacing.
 */
export function slideToPixel(s: SlideGeometry): (x: number, y: number) => [number, number] {
  const o = s.orientation ?? [0, -1, 0, -1, 0, 0];
  const [dr, dc] = s.spacing ?? [1, 1];
  const [ox, oy] = s.origin ?? [0, 0];
  const a = o[0] * dc, b = o[3] * dr, c = o[1] * dc, d = o[4] * dr;
  const det = a * d - b * c || 1;
  return (x, y) => {
    const X = x - ox, Y = y - oy;
    return [(d * X - b * Y) / det, (-c * X + a * Y) / det];
  };
}
