// Overlays on a slide: Microscopy Bulk Simple Annotations (ANN) and slide segmentations (SEG),
// found among the study's other series by their Referenced Series Sequence. Nothing is fetched
// until a layer is switched on, apart from one small header read per candidate instance.
import type { DecoderPool } from "../../viewer-kit/src/index";
import type { OpenShare, SeriesEntry } from "../core/index";
import { dicomLabToSrgb } from "../core/icc";
import { annotationsIn, parseBulkAnnotations, slideToPixel, ANN_SOP_CLASS, type AnnotationGroup, type BulkAnnotations } from "../core/wsi-ann";
import { levelForScale, parseSlideHeader, type Pyramid } from "../core/wsi";
import { SeriesReader } from "../core/wsi-source";
import { RECORD_PLAINTEXT } from "../core/range";
import { Priority, slideSession, tileKey, type SlideSession } from "./wsi-session";

const SEG_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.66.4";
/** Largest annotation instance read whole. */
const ANN_LIMIT = 512 * 1024 * 1024;

export const PALETTE: [number, number, number][] = [
  [255, 214, 0], [0, 230, 118], [255, 64, 129], [0, 176, 255], [255, 145, 0], [170, 0, 255], [118, 255, 3], [255, 255, 255],
];

interface LayerBase {
  id: string;
  series: SeriesEntry;
  /** Shown in the layers panel. */
  title: string;
  detail: string;
  visible: boolean;
  /** Loading, ready, or failed with a message. */
  state: "idle" | "loading" | "ready" | "failed";
  error: string;
  bytes: number;
}

export interface AnnotationLayer extends LayerBase {
  kind: "annotations";
  data: BulkAnnotations | null;
  groupVisible: boolean[];
  colors: [number, number, number][];
  /** Annotations drawn in the last frame. */
  drawn: number;
}

export interface SegmentationLayer extends LayerBase {
  kind: "segmentation";
  ss: SlideSession | null;
  segmentVisible: boolean[];
  /** Base-level pixels per segmentation pixel, and the segmentation origin on the base level. */
  scale: number;
  offset: [number, number];
}

export type SlideLayer = AnnotationLayer | SegmentationLayer;

/** One small read per instance: its header (Referenced Series, SOP Class, geometry). */
async function headerOf(share: OpenShare, se: SeriesEntry, i: number) {
  const reader = new SeriesReader(share.resolver, share.decryptor, se, { budgetBytes: 4 * 1024 * 1024 });
  const inst = se.instances[i];
  const n = Math.min(inst.length, 2 * RECORD_PLAINTEXT - (inst.offset % RECORD_PLAINTEXT));
  const bytes = await reader.read(inst.offset, inst.offset + n, { priority: Priority.Near, purpose: "header" });
  return parseSlideHeader(bytes, { partial: true });
}

/** The study's annotation and segmentation series that refer to this slide series. */
export async function findLayers(share: OpenShare, slide: SeriesEntry, others: SeriesEntry[]): Promise<SlideLayer[]> {
  const out: SlideLayer[] = [];
  for (const se of others) {
    if (se === slide) continue;
    const ann = se.instances.some((i) => i.sopClass === ANN_SOP_CLASS) || se.modality === "ANN";
    const seg = se.instances.some((i) => i.sopClass === SEG_SOP_CLASS) || se.modality === "SEG";
    if (!ann && !seg) continue;
    let h;
    try {
      h = await headerOf(share, se, 0);
    } catch {
      continue;
    }
    if (!h.referencedSeries.includes(slide.uid)) continue;
    const bytes = se.instances.reduce((a, i) => a + i.length, 0);
    if (ann) {
      out.push({ kind: "annotations", id: `ann:${se.fileId}`, series: se, title: se.description || "Annotations", detail: "", visible: false, state: "idle", error: "", bytes, data: null, groupVisible: [], colors: [], drawn: 0 });
    } else if (h.dimensionOrganization.startsWith("TILED") || h.totalColumns) {
      const labels = h.segments.map((g) => g.label).filter(Boolean);
      out.push({
        kind: "segmentation", id: `seg:${se.fileId}`, series: se,
        title: se.description || labels.join(", ") || "Segmentation",
        detail: `${h.segmentationType === "FRACTIONAL" ? "Fractional" : "Binary"} segmentation`,
        visible: false, state: "idle", error: "", bytes, ss: null, segmentVisible: [], scale: 1, offset: [0, 0],
      });
    }
  }
  return out;
}

/** Loads a layer's data (whole annotation instance; segmentation headers). */
export async function loadLayer(layer: SlideLayer, share: OpenShare, pool: DecoderPool, slide: Pyramid) {
  if (layer.state === "ready" || layer.state === "loading") return;
  layer.state = "loading";
  try {
    if (layer.kind === "annotations") {
      const se = layer.series;
      const reader = new SeriesReader(share.resolver, share.decryptor, se, { budgetBytes: 8 * 1024 * 1024 });
      const groups: AnnotationGroup[] = [];
      let first: BulkAnnotations | null = null;
      for (const inst of se.instances) {
        if (inst.length > ANN_LIMIT) throw new Error(`an annotation instance of ${inst.length} bytes is too large to read`);
        const bytes = await reader.read(inst.offset, inst.offset + inst.length, { priority: Priority.Near, purpose: "image" });
        const a = parseBulkAnnotations(bytes, slide);
        first ??= a;
        groups.push(...a.groups);
      }
      layer.data = { ...first!, groups };
      layer.groupVisible = groups.map(() => true);
      layer.colors = groups.map((g, k) => g.color ?? PALETTE[k % PALETTE.length]);
      if (!layer.series.description) layer.title = [...new Set(groups.map((g) => g.label))].join(", ") || layer.title;
      layer.detail = groups.map((g) => `${g.label}: ${g.count.toLocaleString()} ${g.graphicType.toLowerCase()}${g.count === 1 ? "" : "s"}`).join(" · ");
    } else {
      const ss = await slideSession(share, layer.series, pool, { mode: "segmentation" });
      const p = ss.pyramid;
      const segs = ss.src.headers.find((h) => h?.segments.length)?.segments ?? [];
      ss.segmentColors = p.paths.map((path, k) => {
        const g = segs.find((s) => String(s.number) === path.id);
        return g?.lab ? dicomLabToSrgb(g.lab) : PALETTE[(k + 1) % PALETTE.length];
      });
      layer.segmentVisible = p.paths.map(() => true);
      // Placement: by physical spacing and origin when both images give them, else by width.
      if (p.spacing && slide.spacing) {
        layer.scale = p.spacing[1] / slide.spacing[1];
        const o = p.origin && slide.origin ? slideToPixel(slide)(p.origin[0], p.origin[1]) : [0, 0];
        layer.offset = [Math.abs(o[0]) < 1e-6 ? 0 : o[0], Math.abs(o[1]) < 1e-6 ? 0 : o[1]];
      } else {
        layer.scale = slide.width / p.width;
        layer.offset = [0, 0];
      }
      layer.ss = ss;
    }
    layer.state = "ready";
  } catch (e) {
    layer.state = "failed";
    layer.error = (e as Error)?.message ?? String(e);
    layer.visible = false;
  }
}

/** Bytes read for a layer so far. */
export function layerBytes(layer: SlideLayer): number {
  if (layer.kind === "segmentation") return layer.ss?.src.reader.stats.bytes ?? 0;
  return layer.state === "ready" ? layer.bytes : 0;
}

export interface ViewXf {
  cx: number;
  cy: number;
  scale: number;
  W: number;
  H: number;
  dpr: number;
}

/** Segmentation tiles wanted for the view (the layer's own level choice), nearest first. */
export function segmentationWants(layer: SegmentationLayer, v: ViewXf): { key: string; k: number; tx: number; ty: number; path: number; d: number }[] {
  const ss = layer.ss;
  if (!ss || !layer.visible) return [];
  const p = ss.pyramid;
  const k = levelForScale(p, (v.scale * layer.scale) / v.dpr / 1.5);
  const L = p.levels[k];
  const f = layer.scale * L.downsample; // base px per seg-level px
  const x0 = (v.cx - v.W / (2 * v.scale) - layer.offset[0]) / f, x1 = (v.cx + v.W / (2 * v.scale) - layer.offset[0]) / f;
  const y0 = (v.cy - v.H / (2 * v.scale) - layer.offset[1]) / f, y1 = (v.cy + v.H / (2 * v.scale) - layer.offset[1]) / f;
  const out: { key: string; k: number; tx: number; ty: number; path: number; d: number }[] = [];
  const tx0 = Math.max(0, Math.floor(x0 / L.tileWidth)), tx1 = Math.min(L.tilesAcross - 1, Math.floor(x1 / L.tileWidth));
  const ty0 = Math.max(0, Math.floor(y0 / L.tileHeight)), ty1 = Math.min(L.tilesDown - 1, Math.floor(y1 / L.tileHeight));
  for (let path = 0; path < p.paths.length; path++) {
    if (!layer.segmentVisible[path]) continue;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!L.frameRef(tx, ty, 0, path)) continue;
        const d = Math.hypot(((tx + 0.5) * L.tileWidth) * f + layer.offset[0] - v.cx, ((ty + 0.5) * L.tileHeight) * f + layer.offset[1] - v.cy);
        out.push({ key: tileKey(k, tx, ty, 0, path), k, tx, ty, path, d });
      }
  }
  return out;
}

/** Draws a segmentation's cached tiles (its chosen level, falling back to coarser ones). */
export function drawSegmentation(ctx: CanvasRenderingContext2D, layer: SegmentationLayer, v: ViewXf) {
  const ss = layer.ss;
  if (!ss || !layer.visible) return;
  const p = ss.pyramid;
  const want = levelForScale(p, (v.scale * layer.scale) / v.dpr / 1.5);
  const X = (bx: number) => Math.round((bx - v.cx) * v.scale + v.W / 2);
  const Y = (by: number) => Math.round((by - v.cy) * v.scale + v.H / 2);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (let k = p.levels.length - 1; k >= want; k--) {
    const L = p.levels[k];
    const f = layer.scale * L.downsample;
    const tx0 = Math.max(0, Math.floor((v.cx - v.W / (2 * v.scale) - layer.offset[0]) / f / L.tileWidth));
    const tx1 = Math.min(L.tilesAcross - 1, Math.floor((v.cx + v.W / (2 * v.scale) - layer.offset[0]) / f / L.tileWidth));
    const ty0 = Math.max(0, Math.floor((v.cy - v.H / (2 * v.scale) - layer.offset[1]) / f / L.tileHeight));
    const ty1 = Math.min(L.tilesDown - 1, Math.floor((v.cy + v.H / (2 * v.scale) - layer.offset[1]) / f / L.tileHeight));
    for (let path = 0; path < p.paths.length; path++) {
      if (!layer.segmentVisible[path]) continue;
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          const t = ss.peek(k, tx, ty, 0, path);
          if (!t?.bmp) continue;
          const lx = tx * L.tileWidth, ly = ty * L.tileHeight;
          const w = Math.min(L.tileWidth, L.width - lx), h = Math.min(L.tileHeight, L.height - ly);
          const dx0 = X(lx * f + layer.offset[0]), dy0 = Y(ly * f + layer.offset[1]);
          const dx1 = X((lx + w) * f + layer.offset[0]), dy1 = Y((ly + h) * f + layer.offset[1]);
          if (dx1 > dx0 && dy1 > dy0) ctx.drawImage(t.bmp, 0, 0, w, h, dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
    }
  }
  ctx.restore();
}

/** Draws the visible annotations in view; tiny ones as dots. Returns how many were drawn. */
export function drawAnnotations(ctx: CanvasRenderingContext2D, layer: AnnotationLayer, v: ViewXf): number {
  const data = layer.data;
  if (!data || !layer.visible) return 0;
  const x0 = v.cx - v.W / (2 * v.scale), x1 = v.cx + v.W / (2 * v.scale);
  const y0 = v.cy - v.H / (2 * v.scale), y1 = v.cy + v.H / (2 * v.scale);
  const X = (bx: number) => (bx - v.cx) * v.scale + v.W / 2;
  const Y = (by: number) => (by - v.cy) * v.scale + v.H / 2;
  let drawn = 0;
  ctx.save();
  ctx.lineWidth = Math.max(1, 1.5 * v.dpr);
  ctx.lineJoin = "round";
  data.groups.forEach((g, gi) => {
    if (!layer.groupVisible[gi]) return;
    const [r, gg, b] = layer.colors[gi];
    ctx.strokeStyle = `rgb(${r},${gg},${b})`;
    ctx.fillStyle = `rgb(${r},${gg},${b})`;
    const hits = annotationsIn(g, x0, y0, x1, y1);
    const dot = Math.max(2, 2 * v.dpr);
    const path = new Path2D();
    for (const k of hits) {
      const b0 = k * 4;
      const sizePx = Math.max(g.bbox[b0 + 2] - g.bbox[b0], g.bbox[b0 + 3] - g.bbox[b0 + 1]) * v.scale;
      const a = g.starts[k], e = g.starts[k + 1];
      if (g.graphicType === "POINT" || sizePx < 3) {
        ctx.fillRect(X((g.bbox[b0] + g.bbox[b0 + 2]) / 2) - dot / 2, Y((g.bbox[b0 + 1] + g.bbox[b0 + 3]) / 2) - dot / 2, dot, dot);
      } else if (g.graphicType === "ELLIPSE" && e - a === 4) {
        // Endpoints of the major axis, then of the minor axis.
        const mx = (g.xy[2 * a] + g.xy[2 * a + 2]) / 2, my = (g.xy[2 * a + 1] + g.xy[2 * a + 3]) / 2;
        const rx = Math.hypot(g.xy[2 * a + 2] - g.xy[2 * a], g.xy[2 * a + 3] - g.xy[2 * a + 1]) / 2;
        const ry = Math.hypot(g.xy[2 * a + 6] - g.xy[2 * a + 4], g.xy[2 * a + 7] - g.xy[2 * a + 5]) / 2;
        const rot = Math.atan2(g.xy[2 * a + 3] - g.xy[2 * a + 1], g.xy[2 * a + 2] - g.xy[2 * a]);
        path.moveTo(X(mx) + rx * v.scale * Math.cos(rot), Y(my) + rx * v.scale * Math.sin(rot));
        path.ellipse(X(mx), Y(my), rx * v.scale, ry * v.scale, rot, 0, Math.PI * 2);
      } else {
        path.moveTo(X(g.xy[2 * a]), Y(g.xy[2 * a + 1]));
        for (let i = a + 1; i < e; i++) path.lineTo(X(g.xy[2 * i]), Y(g.xy[2 * i + 1]));
        if (g.graphicType !== "POLYLINE") path.closePath();
      }
      drawn++;
    }
    ctx.stroke(path);
  });
  ctx.restore();
  layer.drawn = drawn;
  return drawn;
}
