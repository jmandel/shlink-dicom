// Measurements on the image: length, angle and area, calibrated from the image's pixel spacing
// (core/geometry.ts) with the source of the calibration shown next to the result. Drawn on their
// own canvas over the stage; points are kept in image pixel coordinates, per image and frame.
import { geometryOf, spacingSourceText, type Geometry } from "../core/geometry";
import type { DataSet } from "../core/dicom";

export type Tool = "length" | "angle" | "area";

interface Shape {
  tool: Tool;
  /** Image pixel coordinates (top-left corner of the top-left pixel is 0,0). */
  pts: { x: number; y: number }[];
  done: boolean;
}

export interface MeasureView {
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  zoom: number;
  panX: number;
  panY: number;
  /** Canvas pixels per CSS pixel. */
  scale: number;
  header: DataSet | null;
  frame: number;
  /** Image key: SOP instance and frame. */
  key: string;
  /** Pixel spacing to use instead of the header's (reformatted planes): [rows, columns] in mm. */
  spacing?: [number, number];
}

export interface Result {
  text: string;
  calibration: string;
}

export class Measure {
  readonly canvas: HTMLCanvasElement;
  tool: Tool | null = null;
  private shapes = new Map<string, Shape[]>();
  private v: MeasureView | null = null;
  onResult: ((r: Result | null) => void) | null = null;

  constructor(stage: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "measure-canvas";
    stage.append(this.canvas);
  }

  get active() {
    return this.tool !== null;
  }

  private geometry(): Geometry | null {
    if (this.v?.spacing) return { position: null, row: null, col: null, spacing: this.v.spacing, spacingSource: "pixel-spacing", sliceThickness: null };
    return this.v?.header ? geometryOf(this.v.header, this.v.frame > 0 || (this.v.header.num(0x00280008) ?? 1) > 1 ? this.v.frame : null) : null;
  }

  private map() {
    const v = this.v!;
    const s = Math.min(v.cw / v.cols, v.ch / v.rows) * v.zoom;
    return {
      toCanvas: (p: { x: number; y: number }) => ({ x: v.cw / 2 + v.panX + (p.x - v.cols / 2) * s, y: v.ch / 2 + v.panY + (p.y - v.rows / 2) * s }),
      toImage: (cx: number, cy: number) => ({ x: (cx - v.cw / 2 - v.panX) / s + v.cols / 2, y: (cy - v.ch / 2 - v.panY) / s + v.rows / 2 }),
    };
  }

  update(v: MeasureView | null) {
    this.v = v;
    this.draw();
  }

  clear() {
    if (this.v) this.shapes.delete(this.v.key);
    this.draw();
    this.onResult?.(null);
  }

  /** A pointer event at client coordinates on the stage (only while a tool is active). */
  pointer(type: "down" | "move" | "up", clientX: number, clientY: number, doubleTap = false) {
    if (!this.tool || !this.v) return;
    const r = this.canvas.getBoundingClientRect();
    const p = this.map().toImage((clientX - r.left) * this.v.scale, (clientY - r.top) * this.v.scale);
    const list = this.shapes.get(this.v.key) ?? [];
    this.shapes.set(this.v.key, list);
    let cur = list[list.length - 1];
    if (type === "down") {
      if (!cur || cur.done || cur.tool !== this.tool) {
        cur = { tool: this.tool, pts: [p, { ...p }], done: false };
        list.push(cur);
      } else if (this.tool !== "length") {
        // Angle: three points. Area: points until a double tap or a tap on the first point.
        const first = this.map().toCanvas(cur.pts[0]), here = this.map().toCanvas(p);
        const closes = this.tool === "area" && cur.pts.length > 3 && (doubleTap || Math.hypot(first.x - here.x, first.y - here.y) < 12 * this.v.scale);
        if (closes) {
          cur.pts.pop();
          cur.done = true;
        } else cur.pts.push({ ...p });
      }
    } else if (type === "move" && cur && !cur.done) {
      cur.pts[cur.pts.length - 1] = p;
    } else if (type === "up" && cur && !cur.done) {
      cur.pts[cur.pts.length - 1] = p;
      if (cur.tool === "length") cur.done = true;
      if (cur.tool === "angle" && cur.pts.length === 3) cur.done = true;
    }
    this.draw();
    if (cur) this.onResult?.(this.result(cur));
  }

  /** A length between two image points (pixel corners coordinates), as the Length tool reports it. */
  measureAt(x0: number, y0: number, x1: number, y1: number): Result {
    return this.result({ tool: "length", pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }], done: true });
  }

  /** The value of a shape in mm (or pixels when uncalibrated), with the calibration source. */
  result(sh: Shape): Result {
    const g = this.geometry();
    const sp = g?.spacing ?? null;
    const calibration = spacingSourceText(sp ? g!.spacingSource : "none");
    const dx = (a: { x: number }, b: { x: number }) => (b.x - a.x) * (sp ? sp[1] : 1);
    const dy = (a: { y: number }, b: { y: number }) => (b.y - a.y) * (sp ? sp[0] : 1);
    const unit = sp ? "mm" : "px";
    if (sh.tool === "length") {
      const [a, b] = sh.pts;
      return { text: `${Math.hypot(dx(a, b), dy(a, b)).toFixed(sp ? 1 : 0)} ${unit}`, calibration };
    }
    if (sh.tool === "angle") {
      if (sh.pts.length < 3) return { text: "…", calibration: "" };
      const [a, o, b] = sh.pts;
      // Angles use calibrated vectors: non-square pixels change them.
      const u = [dx(o, a), dy(o, a)], w = [dx(o, b), dy(o, b)];
      const ang = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]) || 1)))) * 180) / Math.PI;
      return { text: `${ang.toFixed(1)}°`, calibration: sp && sp[0] !== sp[1] ? calibration : "" };
    }
    let area = 0;
    const n = sh.pts.length;
    for (let i = 0; i < n; i++) {
      const p = sh.pts[i], q = sh.pts[(i + 1) % n];
      area += p.x * (sp ? sp[1] : 1) * (q.y * (sp ? sp[0] : 1)) - q.x * (sp ? sp[1] : 1) * (p.y * (sp ? sp[0] : 1));
    }
    area = Math.abs(area) / 2;
    return { text: sp ? `${(area / 100).toFixed(2)} cm²` : `${area.toFixed(0)} px²`, calibration };
  }

  draw() {
    const c = this.canvas, v = this.v;
    if (!v) return;
    if (c.width !== v.cw || c.height !== v.ch) {
      c.width = v.cw;
      c.height = v.ch;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const list = this.shapes.get(v.key) ?? [];
    const m = this.map();
    const k = v.scale;
    g.lineWidth = 2 * k;
    g.font = `${Math.round(13 * k)}px system-ui, sans-serif`;
    g.textBaseline = "bottom";
    for (const sh of list) {
      const pts = sh.pts.map(m.toCanvas);
      g.strokeStyle = "#38d1ff";
      g.fillStyle = "rgba(56,209,255,0.12)";
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (sh.tool === "area" && sh.done) {
        g.closePath();
        g.fill();
      }
      g.stroke();
      for (const p of pts) {
        g.beginPath();
        g.arc(p.x, p.y, 3 * k, 0, Math.PI * 2);
        g.stroke();
      }
      const r = this.result(sh);
      const anchor = pts[sh.tool === "angle" && pts.length > 1 ? 1 : pts.length - 1];
      g.fillStyle = "#38d1ff";
      g.shadowColor = "#000";
      g.shadowBlur = 3;
      g.fillText(r.text, anchor.x + 8 * k, anchor.y - 6 * k);
      g.shadowBlur = 0;
    }
    c.dataset.shapes = String(list.length);
  }
}
