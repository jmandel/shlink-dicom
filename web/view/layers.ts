// Layers drawn over the image: segmentations (SEG), RT structure sets, parametric maps and
// presentation states (GSPS) from the same study, matched to the image on screen by SOP Instance UID or, failing
// that, by plane position in the same frame of reference. A canvas over the stage, in the same
// geometry as the image (fit to the stage, then the viewer's zoom and pan).
import { frameOf, type DecoderPool, type DecodedImage } from "../../viewer-kit/src/index";
import type { SeriesEntry, StudyEntry } from "../core/bundle";
import { parseDicom, T, type DataSet } from "../core/dicom";
import {
  readParametricMap,
  readPresentationState,
  readSegmentation,
  readStructureSet,
  refersTo,
  type ParametricMap,
  type PresentationState,
  type Segmentation,
  type StructureSet,
} from "../core/derived";
import { dot, geometryOf, normal, patientToPixel, sub, type Geometry } from "../core/geometry";
import type { InstanceLoader } from "../core/loader";
import { seriesKind, sopInfo } from "../core/objects";
import { overlayBitsFromPixels, readOverlays, type OverlayPlane } from "../core/overlays";
import { formatValue, realValue, unitText } from "../core/display";

export type LayerKind = "seg" | "rtstruct" | "pmap" | "pr";

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  /** The series holding the object, and the instance. */
  series: SeriesEntry;
  index: number;
  /** Series Instance UIDs the object refers to. */
  refSeries: string[];
  frameOfReference: string | null;
  seg?: Segmentation;
  /** Decoded pixels of a segmentation or parametric map, on first use. */
  segPixels?: DecodedImage | null;
  pmap?: ParametricMap;
  rt?: StructureSet;
  ps?: PresentationState;
}

/** What the viewer has on screen, for drawing. */
export interface Target {
  series: SeriesEntry;
  sop: string;
  /** 0-based frame in the instance. */
  frame: number;
  img: DecodedImage;
  header: DataSet | null;
  /** Canvas size (device pixels) and the viewer's zoom and pan. */
  cw: number;
  ch: number;
  zoom: number;
  panX: number;
  panY: number;
}

const POS_TOLERANCE_MM = 0.05;

export class Layers {
  readonly canvas: HTMLCanvasElement;
  layers: Layer[] = [];
  /** Layers switched on (segmentations and structure sets). */
  readonly on = new Set<string>();
  /** Segments and ROIs switched off within an enabled layer: `${layer}/${number}`. */
  readonly hidden = new Set<string>();
  /** The presentation state applied, if any. */
  applied: Layer | null = null;
  /** Overlay planes stored in the images (60xx): drawn unless turned off. */
  overlaysOn = true;
  /** Planes of the image on screen (for the Layers sheet). */
  planes: OverlayPlane[] = [];
  private planeCache = new WeakMap<DecodedImage, OverlayPlane[]>();
  /** Raw pixel data of an instance, for overlays in the pixel data's high bits. */
  rawPixels: ((series: SeriesEntry, sop: string) => Promise<Uint8Array | null>) | null = null;
  private target: Target | null = null;
  private scanned: StudyEntry[] | null = null;
  private scanning: Promise<void> | null = null;
  onChange: (() => void) | null = null;
  /** A layer's pixels have been decoded (its legend can show the data range). */
  onDecoded: (() => void) | null = null;

  constructor(
    stage: HTMLElement,
    private loader: () => InstanceLoader,
    private pool: () => DecoderPool,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "layer-canvas";
    stage.append(this.canvas);
  }

  /** Reads every segmentation, structure set and presentation state in the share (once): they may refer to images in another study. */
  scan(studies: StudyEntry[]): Promise<void> {
    if (this.scanned === studies && this.scanning) return this.scanning;
    this.scanned = studies;
    this.layers = [];
    this.on.clear();
    this.hidden.clear();
    this.applied = null;
    this.scanning = (async () => {
      const jobs: Promise<void>[] = [];
      for (const se of studies.flatMap((st) => st.series)) {
        const kind = seriesKind(se.instances.map((i) => i.sopClass));
        if (kind !== "seg" && kind !== "rtstruct" && kind !== "pmap" && kind !== "pr") continue;
        se.instances.forEach((inst, index) =>
          jobs.push(
            (async () => {
              const bytes = await this.loader().instance(se, index);
              const { ds } = await parseDicom(bytes);
              const base = { id: `${se.id}/${index}`, kind, series: se, index, frameOfReference: ds.str(T.FrameOfReferenceUID) };
              if (kind === "seg") {
                const seg = readSegmentation(ds);
                this.layers.push({ ...base, kind, name: se.description ?? "Segmentation", refSeries: seg.referenced.map((r) => r.series), seg, segPixels: undefined, frameOfReference: seg.frameOfReference });
                // Pixels decoded on first use.
                (this.layers[this.layers.length - 1] as any).bytes = bytes;
              } else if (kind === "pmap") {
                const pm = readParametricMap(ds);
                const refSeries = [...new Set([...pm.referenced.map((r) => r.series), ...pm.frames.map((f) => f.source?.series).filter((x): x is string => !!x)])];
                const label = pm.realWorld?.label || se.description || "Parametric map";
                this.layers.push({ ...base, kind, name: label, refSeries, pmap: pm, segPixels: undefined, frameOfReference: pm.frameOfReference });
                (this.layers[this.layers.length - 1] as any).bytes = bytes;
              } else if (kind === "rtstruct") {
                const rt = readStructureSet(ds);
                this.layers.push({ ...base, kind, name: rt.label || se.description || "Structure set", refSeries: rt.series, rt, frameOfReference: rt.frameOfReference });
              } else {
                const ps = readPresentationState(ds);
                this.layers.push({ ...base, kind, name: ps.label || ps.description || se.description || sopInfo(inst.sopClass).name, refSeries: ps.series, ps });
              }
            })().catch(() => {}),
          ),
        );
      }
      await Promise.all(jobs);
      this.layers.sort((a, b) => a.id.localeCompare(b.id));
      this.onChange?.();
    })();
    return this.scanning;
  }

  /** Layers that apply to a series: it is referenced, or (contours, segmentations) it shares the frame of reference. */
  forSeries(se: SeriesEntry, frameOfReference: string | null): Layer[] {
    return this.layers.filter((l) => l.series !== se && (l.refSeries.includes(se.uid) || (l.kind !== "pr" && frameOfReference && l.frameOfReference === frameOfReference)));
  }

  async toggle(l: Layer, on: boolean) {
    if (on) this.on.add(l.id);
    else this.on.delete(l.id);
    if (on && (l.kind === "seg" || l.kind === "pmap") && l.segPixels === undefined) {
      l.segPixels = null;
      try {
        const bytes = (l as any).bytes as Uint8Array;
        l.segPixels = await this.pool().decode(bytes.slice(), { priority: 0 });
      } catch {
        l.segPixels = null;
      }
      this.onDecoded?.();
    }
    this.redraw();
    this.onChange?.();
  }

  update(t: Target | null) {
    this.target = t;
    this.redraw();
  }

  clear() {
    this.target = null;
    const c = this.canvas;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
  }

  /** Image pixel coordinates (top-left corner of the top-left pixel is 0,0) → canvas pixels. */
  private mapper(t: Target) {
    const cols = t.img.fullColumns ?? t.img.columns, rows = t.img.fullRows ?? t.img.rows;
    const s = Math.min(t.cw / cols, t.ch / rows) * t.zoom;
    return {
      s,
      x: (gx: number) => t.cw / 2 + t.panX + (gx - cols / 2) * s,
      y: (gy: number) => t.ch / 2 + t.panY + (gy - rows / 2) * s,
      cols,
      rows,
    };
  }

  redraw() {
    const c = this.canvas, t = this.target;
    if (!t) return;
    if (c.width !== t.cw || c.height !== t.ch) {
      c.width = t.cw;
      c.height = t.ch;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const geom = t.header ? geometryOf(t.header, (t.header.num(T.NumberOfFrames) ?? 1) > 1 ? t.frame : null) : null;
    const m = this.mapper(t);
    let drawn = 0;
    for (const l of this.layers) {
      if (!this.on.has(l.id)) continue;
      if (l.kind === "seg") drawn += this.drawSeg(g, l, t, geom, m);
      else if (l.kind === "rtstruct") drawn += this.drawRt(g, l, t, geom, m);
      else if (l.kind === "pmap") drawn += this.drawMap(g, l, t, geom, m);
    }
    if (this.applied?.ps) drawn += this.drawPs(g, this.applied.ps, t, m);
    if (this.overlaysOn) drawn += this.drawPlanes(g, t, m);
    c.dataset.drawn = String(drawn);
  }

  /** The image's own overlay planes (60xx), in white as DICOM viewers conventionally draw them. */
  private drawPlanes(g: CanvasRenderingContext2D, t: Target, m: ReturnType<Layers["mapper"]>): number {
    if (!t.header) return 0;
    let planes = this.planeCache.get(t.img);
    if (!planes) {
      planes = readOverlays(t.header);
      this.planeCache.set(t.img, planes);
      const missing = planes.filter((p) => !p.bits && p.bitPosition !== null);
      if (missing.length && this.rawPixels) {
        const img = t.img, rows = t.img.fullRows ?? t.img.rows, cols = t.img.fullColumns ?? t.img.columns;
        void this.rawPixels(t.series, t.sop).then((px) => {
          if (!px) return;
          overlayBitsFromPixels(missing, px, rows, cols, img.bitsAllocated);
          if (this.target?.img === img) this.redraw();
        });
      }
    }
    this.planes = planes;
    let count = 0;
    for (const p of planes) {
      if (!p.bits) continue;
      const f = t.frame + 1 - p.frameOrigin;
      if (f < 0 || f >= p.frames) continue;
      const n = p.rows * p.columns;
      const im = new ImageData(p.columns, p.rows);
      let any = 0;
      for (let i = 0; i < n; i++) {
        if (p.bits[f * n + i]) {
          im.data.set([255, 255, 255, 255], i * 4);
          any++;
        }
      }
      if (!any) continue;
      const oc = new OffscreenCanvas(p.columns, p.rows);
      oc.getContext("2d")!.putImageData(im, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(oc, m.x(p.origin[1] - 1), m.y(p.origin[0] - 1), p.columns * m.s, p.rows * m.s);
      count++;
    }
    this.canvas.dataset.planes = String(planes.length);
    return count;
  }

  /** Overlay plane bits of the image on screen (for checks): one byte per pixel, image-sized. */
  planeMask(): Uint8Array | null {
    const t = this.target;
    if (!t) return null;
    const rows = t.img.rows, cols = t.img.columns;
    const mask = new Uint8Array(rows * cols);
    for (const p of this.planes) {
      if (!p.bits) continue;
      const f = t.frame + 1 - p.frameOrigin;
      if (f < 0 || f >= p.frames) continue;
      for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.columns; c++) {
        const y = r + p.origin[0] - 1, x = c + p.origin[1] - 1;
        if (y >= 0 && y < rows && x >= 0 && x < cols && p.bits[f * p.rows * p.columns + r * p.columns + c]) mask[y * cols + x] = 1;
      }
    }
    return mask;
  }

  /** Segmentation frames for this image: by source reference, else by plane position. */
  private drawSeg(g: CanvasRenderingContext2D, l: Layer, t: Target, geom: Geometry | null, m: ReturnType<Layers["mapper"]>): number {
    const seg = l.seg!, px = l.segPixels;
    if (!px) return 0;
    const n = geom ? normal(geom) : null;
    let count = 0;
    seg.frames.forEach((f, k) => {
      const bySource = f.source && f.source.sopInstance === t.sop && (!f.source.frames.length || f.source.frames.includes(t.frame + 1));
      const byPos = !f.source && geom?.position && f.position && n && Math.abs(dot(sub(f.position, geom.position), n)) < POS_TOLERANCE_MM;
      if (!bySource && !byPos) return;
      const segment = seg.segments.find((s) => s.number === f.segment);
      if (!segment || this.hidden.has(`${l.id}/${segment.number}`)) return;
      const off = px.frameOffsets[k];
      if (off === undefined) return;
      const data = new Uint8Array(px.pixels, off, px.rows * px.columns);
      const im = new ImageData(px.columns, px.rows);
      const [r, gr, b] = segment.color;
      const max = seg.kind === "FRACTIONAL" ? seg.fractionalMax || 255 : 1;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!v) continue;
        const o = i * 4;
        im.data[o] = r;
        im.data[o + 1] = gr;
        im.data[o + 2] = b;
        im.data[o + 3] = Math.round(110 * Math.min(1, v / max));
      }
      const off2 = new OffscreenCanvas(px.columns, px.rows);
      off2.getContext("2d")!.putImageData(im, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(off2, m.x(0), m.y(0), m.cols * m.s, m.rows * m.s);
      count++;
    });
    return count;
  }

  /**
   * A parametric map's frames for this image (by source reference, else by plane position), in
   * colour: its palette when it has one, else a viridis-like scale, over mapScale's range. Values
   * at or below the low end and missing values (NaN) are left clear.
   */
  private drawMap(g: CanvasRenderingContext2D, l: Layer, t: Target, geom: Geometry | null, m: ReturnType<Layers["mapper"]>): number {
    const pm = l.pmap!, px = l.segPixels;
    if (!px) return 0;
    const n = geom ? normal(geom) : null;
    const half = Math.max(POS_TOLERANCE_MM, (geom?.sliceThickness ?? 0) / 2);
    const { lo, hi } = mapScale(l);
    const lut = pm.palette ?? DEFAULT_SCALE;
    let count = 0;
    pm.frames.forEach((f, k) => {
      const fg = f.geometry;
      const bySource = f.source && f.source.sopInstance === t.sop && (!f.source.frames.length || f.source.frames.includes(t.frame + 1));
      const byPos = !f.source && geom?.position && fg.position && n && Math.abs(dot(sub(fg.position, geom.position), n)) < half;
      if (!bySource && !byPos) return;
      if (k >= px.frames) return;
      const fr = frameOf(px, k);
      const im = new ImageData(px.columns, px.rows);
      const span = hi - lo || 1;
      for (let i = 0; i < fr.data.length; i++) {
        const v = realValue(fr.data[i], pm.realWorld, fr);
        if (!(v > lo)) continue;
        const c = Math.min(255, Math.floor(((v - lo) / span) * 255));
        im.data.set([lut[c * 4], lut[c * 4 + 1], lut[c * 4 + 2], 150], i * 4);
      }
      const oc = new OffscreenCanvas(px.columns, px.rows);
      oc.getContext("2d")!.putImageData(im, 0, 0);
      g.imageSmoothingEnabled = false;
      // Placed by geometry when both planes have it (the map may be coarser than the image), else stretched over the image.
      const p0 = geom && fg.position && fg.spacing && geom.spacing ? patientToPixel(geom, fg.position) : null;
      if (p0 && fg.spacing && geom?.spacing) {
        const sx = fg.spacing[1] / geom.spacing[1], sy = fg.spacing[0] / geom.spacing[0];
        g.drawImage(oc, m.x(p0.x + 0.5 - sx / 2), m.y(p0.y + 0.5 - sy / 2), px.columns * sx * m.s, px.rows * sy * m.s);
      } else g.drawImage(oc, m.x(0), m.y(0), m.cols * m.s, m.rows * m.s);
      count++;
    });
    return count;
  }

  /** Contours on this image: those that name it, else those within half a slice of its plane. */
  private drawRt(g: CanvasRenderingContext2D, l: Layer, t: Target, geom: Geometry | null, m: ReturnType<Layers["mapper"]>): number {
    if (!geom) return 0;
    const half = Math.max(0.5, (geom.sliceThickness ?? 1) / 2);
    let count = 0;
    g.lineWidth = Math.max(1.5, devicePixelRatio || 1);
    for (const roi of l.rt!.rois) {
      if (this.hidden.has(`${l.id}/${roi.number}`)) continue;
      g.strokeStyle = `rgb(${roi.color.join(",")})`;
      g.fillStyle = `rgba(${roi.color.join(",")},0.15)`;
      for (const c of roi.contours) {
        const named = c.images.includes(t.sop);
        const pts: { x: number; y: number }[] = [];
        let near = !c.images.length || named;
        for (let i = 0; i + 2 < c.points.length; i += 3) {
          const p = patientToPixel(geom, [c.points[i], c.points[i + 1], c.points[i + 2]]);
          if (!p) return count;
          if (!named && Math.abs(p.dist) > half) near = false;
          pts.push({ x: m.x(p.x + 0.5), y: m.y(p.y + 0.5) });
        }
        if (!near || !pts.length || (c.images.length && !named)) continue;
        g.beginPath();
        if (c.type === "POINT" || pts.length === 1) {
          g.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2);
          g.stroke();
        } else {
          pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          if (c.type === "CLOSED_PLANAR") {
            g.closePath();
            g.fill();
          }
          g.stroke();
        }
        count++;
      }
    }
    return count;
  }

  /** A presentation state's shutters, graphics and text for this image. */
  private drawPs(g: CanvasRenderingContext2D, ps: PresentationState, t: Target, m: ReturnType<Layers["mapper"]>): number {
    if (!refersTo(ps.images, t.sop, t.frame + 1)) return 0;
    let count = 0;
    // Displayed area, for DISPLAY units (0–1 across the displayed area).
    const area = ps.displayedArea.find((d) => refersTo(d.images, t.sop, t.frame + 1));
    const ax0 = area ? area.tl[0] - 1 : 0, ay0 = area ? area.tl[1] - 1 : 0;
    const ax1 = area ? area.br[0] : m.cols, ay1 = area ? area.br[1] : m.rows;
    const X = (x: number, u: string) => m.x(u === "DISPLAY" ? ax0 + x * (ax1 - ax0) : x);
    const Y = (y: number, u: string) => m.y(u === "DISPLAY" ? ay0 + y * (ay1 - ay0) : y);
    if (ps.shutter) {
      const sh = ps.shutter;
      g.save();
      g.beginPath();
      g.rect(0, 0, t.cw, t.ch);
      if (sh.rect) g.rect(m.x(sh.rect.left - 1), m.y(sh.rect.top - 1), (sh.rect.right - sh.rect.left + 1) * m.s, (sh.rect.bottom - sh.rect.top + 1) * m.s);
      if (sh.circle) {
        g.moveTo(m.x(sh.circle.cx - 1) + sh.circle.r * m.s, m.y(sh.circle.cy - 1));
        g.arc(m.x(sh.circle.cx - 1), m.y(sh.circle.cy - 1), sh.circle.r * m.s, 0, Math.PI * 2, true);
      }
      if (sh.polygon && sh.polygon.length >= 6) {
        for (let i = 0; i < sh.polygon.length; i += 2) {
          const x = m.x(sh.polygon[i + 1] - 1), y = m.y(sh.polygon[i] - 1);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.closePath();
      }
      const v = sh.value !== null ? Math.round((sh.value / 65535) * 255) : 0;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fill("evenodd");
      g.restore();
      count++;
    }
    const color = "#ffe14d";
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = Math.max(1.5, devicePixelRatio || 1);
    g.font = `${Math.round(13 * (devicePixelRatio || 1))}px system-ui, sans-serif`;
    g.textBaseline = "top";
    for (const a of ps.annotations) {
      if (!refersTo(a.images, t.sop, t.frame + 1)) continue;
      for (const gr of a.graphics) {
        const p = gr.points;
        g.beginPath();
        if (gr.type === "CIRCLE" && p.length >= 4) {
          const r = Math.hypot(X(p[2], gr.units) - X(p[0], gr.units), Y(p[3], gr.units) - Y(p[1], gr.units));
          g.arc(X(p[0], gr.units), Y(p[1], gr.units), r, 0, Math.PI * 2);
        } else if (gr.type === "ELLIPSE" && p.length >= 8) {
          const cx = (X(p[0], gr.units) + X(p[2], gr.units)) / 2, cy = (Y(p[1], gr.units) + Y(p[3], gr.units)) / 2;
          const rx = Math.hypot(X(p[2], gr.units) - X(p[0], gr.units), Y(p[3], gr.units) - Y(p[1], gr.units)) / 2;
          const ry = Math.hypot(X(p[6], gr.units) - X(p[4], gr.units), Y(p[7], gr.units) - Y(p[5], gr.units)) / 2;
          g.ellipse(cx, cy, rx, ry, Math.atan2(Y(p[3], gr.units) - Y(p[1], gr.units), X(p[2], gr.units) - X(p[0], gr.units)), 0, Math.PI * 2);
        } else if (gr.type === "POINT" && p.length >= 2) {
          g.arc(X(p[0], gr.units), Y(p[1], gr.units), 3, 0, Math.PI * 2);
        } else {
          for (let i = 0; i + 1 < p.length; i += 2) {
            if (i) g.lineTo(X(p[i], gr.units), Y(p[i + 1], gr.units));
            else g.moveTo(X(p[i], gr.units), Y(p[i + 1], gr.units));
          }
        }
        if (gr.filled) g.fill();
        g.stroke();
        count++;
      }
      for (const tx of a.texts) {
        let x: number, y: number;
        if (tx.box) {
          x = X(tx.box.tl[0], tx.box.units);
          y = Y(tx.box.tl[1], tx.box.units);
        } else if (tx.anchor) {
          x = X(tx.anchor.at[0], tx.anchor.units) + 6;
          y = Y(tx.anchor.at[1], tx.anchor.units) + 6;
        } else continue;
        g.save();
        g.shadowColor = "#000";
        g.shadowBlur = 3;
        tx.text.split(/\r?\n/).forEach((line, i) => g.fillText(line, x, y + i * 16 * (devicePixelRatio || 1)));
        g.restore();
        if (tx.anchor?.visible && tx.box) {
          g.beginPath();
          g.moveTo(X(tx.anchor.at[0], tx.anchor.units), Y(tx.anchor.at[1], tx.anchor.units));
          g.lineTo(x, y);
          g.stroke();
        }
        count++;
      }
    }
    return count;
  }
}

/** Viridis-like colour scale, 256 RGBA entries (5 stops, linear between them). */
const DEFAULT_SCALE = (() => {
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const out = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const x = (k / 255) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    for (let c = 0; c < 3; c++) out[k * 4 + c] = Math.round(stops[i][c] * (1 - f) + stops[i + 1][c] * f);
    out[k * 4 + 3] = 255;
  }
  return out;
})();

/** Colours of a parametric map layer (its palette, else the default scale), for legends. */
export function mapColours(l: Layer): Uint8Array {
  return l.pmap?.palette ?? DEFAULT_SCALE;
}

/**
 * The real-value range a parametric map's colours span: the range its Real World Value Mapping
 * covers, else its window, else its data range.
 */
export function mapScale(l: Layer): { lo: number; hi: number; units: string; text: string } {
  const pm = l.pmap!, rw = pm.realWorld, px = l.segPixels;
  const id = { rescaleSlope: px?.rescaleSlope ?? 1, rescaleIntercept: px?.rescaleIntercept ?? 0 };
  let lo = 0, hi = 1;
  if (rw && rw.first != null && rw.last != null) [lo, hi] = [realValue(rw.first, rw, id), realValue(rw.last, rw, id)];
  else if (pm.window) [lo, hi] = [pm.window.center - pm.window.width / 2, pm.window.center + pm.window.width / 2];
  else if (px && px.minValue != null && px.maxValue != null) [lo, hi] = [realValue(px.minValue, rw, id), realValue(px.maxValue, rw, id)];
  if (lo > hi) [lo, hi] = [hi, lo];
  const units = rw ? unitText(rw.units) : "";
  return { lo, hi, units, text: `${formatValue(lo)} – ${formatValue(hi)}${units ? ` ${units}` : ""}` };
}
