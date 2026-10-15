// CPU reference for the GL renderer, and the fallback renderer when WebGL2 is unavailable.
//
// The pipeline, per canvas pixel (identical in the fragment shader, gl-renderer.ts):
//
//   1. Map the canvas pixel centre to image coordinates: img = (p + 0.5 - centre) / scale + size / 2.
//   2. Sample the stored value: nearest = texel floor(img); linear = bilinear over the 4 texels
//      around img - 0.5 (edges clamped). Interpolation is on stored values, before the
//      modality LUT, which is linear, so it equals interpolating rescaled values.
//   3. Modality LUT + VOI window (DICOM PS3.3 C.11.2.1.2, linear):
//        x' = x × m + b              (Rescale Slope m, Intercept b)
//        y  = ((x' − (c − 0.5)) / (w − 1) + 0.5)   clamped to [0, 1]; w = 1 is a threshold at c − 0.5.
//      Rewritten so float32 does not lose the low bits of 16-bit values (see wlParams):
//        y = ((x − xcI) − xcF) × A + B,  xc = ((c − 0.5) − b) / m = xcI (integer) + xcF (fraction)
//      x − xcI is an exact integer subtraction; only the fraction and A are rounded to float32.
//   4. Quantise: k = floor(y × 255 + 0.5). MONOCHROME1 (or the user's invert): k = 255 − k.
//   5. Optional colour map: rgba = colormap[k]. PALETTE COLOR: rgba = palette[x − first] (no window,
//      nearest only). RGB: no window; floor(v × 255 / (2^BitsStored − 1) + 0.5), which is v itself
//      for 8-bit nearest.
//
// The GPU evaluates step 3 in float32 and the CPU in float64, so a value that lands within float32
// rounding of a .5 boundary in step 4 can differ by one level. test/gl-vs-cpu.mjs measures this.
import type { Frame, Samples } from "./types";

export interface View {
  windowCenter: number;
  windowWidth: number;
  /** Multiplies the base scale (fit to canvas, or 1 with fit "none"). */
  zoom: number;
  /** Pan in canvas pixels. */
  panX: number;
  panY: number;
  interpolation: "nearest" | "linear";
  /** User invert; XORed with MONOCHROME1. */
  invert: boolean;
  /** "contain": fit the image in the canvas at zoom 1. "none": zoom 1 is one image pixel per canvas pixel. */
  fit: "contain" | "none";
  /** 256 × RGBA pseudo-colour map applied after windowing, or null for grey. */
  colormap: Uint8Array | null;
}

export const defaultView = (): View => ({
  windowCenter: 0,
  windowWidth: 1,
  zoom: 1,
  panX: 0,
  panY: 0,
  interpolation: "nearest",
  invert: false,
  fit: "contain",
  colormap: null,
});

export interface WlParams {
  xcI: number;
  xcF: number;
  a: number;
  b: number;
  threshold: boolean;
}

/** Window parameters shared by the CPU and GPU paths (computed once per window change, float64). */
export function wlParams(frame: Pick<Frame, "rescaleSlope" | "rescaleIntercept">, c: number, w: number): WlParams {
  const m = frame.rescaleSlope || 0;
  const b = frame.rescaleIntercept || 0;
  if (m === 0) {
    // Constant image: evaluate the window once.
    const y = w <= 1 ? (b > c - 0.5 ? 1 : 0) : (b - (c - 0.5)) / (w - 1) + 0.5;
    return { xcI: 0, xcF: 0, a: 0, b: Math.min(1, Math.max(0, y)), threshold: false };
  }
  const xc = (c - 0.5 - b) / m;
  const xcI = Math.max(-(2 ** 30), Math.min(2 ** 30, Math.floor(xc)));
  const xcF = xc - xcI;
  if (w <= 1) return { xcI, xcF, a: Math.sign(m), b: 0, threshold: true };
  return { xcI, xcF, a: m / (w - 1), b: 0.5, threshold: false };
}

/** Window level 0..255 (before invert) of stored value x. The reference for the shader. */
export function levelOf(x: number, p: WlParams): number {
  const d = (x - p.xcI) - p.xcF;
  let y = p.threshold ? (d * p.a > 0 ? 1 : 0) : d * p.a + p.b;
  y = y < 0 ? 0 : y > 1 ? 1 : y;
  return Math.floor(y * 255 + 0.5);
}

export function isMonochrome1(frame: Frame) {
  return frame.photometric.trim().toUpperCase() === "MONOCHROME1";
}

export function usesPalette(frame: Frame) {
  return frame.samplesPerPixel === 1 && !!frame.palette && frame.photometric.trim().toUpperCase() === "PALETTE COLOR";
}

/** RGB with more than 8 bits is scaled to 8 by Bits Stored. */
export function rgbScale(frame: Frame) {
  const bs = Math.min(32, frame.bitsStored ?? frame.bitsAllocated);
  return bs <= 8 ? 1 : 255 / (2 ** bs - 1);
}

export function viewScale(frame: Frame, view: View, width: number, height: number) {
  const base = view.fit === "contain" ? Math.min(width / frame.columns, height / frame.rows) : 1;
  return base * view.zoom;
}

/**
 * Render `frame` with `view` into an RGBA buffer of width × height (top-left origin). This is the
 * reference the shader is tested against, and what CpuRenderer draws.
 */
export function renderCpu(frame: Frame, view: View, width: number, height: number, out: Uint8ClampedArray | Uint8Array = new Uint8ClampedArray(width * height * 4)) {
  const { columns: cols, rows } = frame;
  const scale = viewScale(frame, view, width, height);
  const inv = 1 / scale;
  const cx = width / 2 + view.panX, cy = height / 2 + view.panY;
  const out32 = new Uint32Array(out.buffer, out.byteOffset, width * height);
  const BLACK = 0xff000000;
  const data = frame.data;
  const pal = usesPalette(frame);
  const linear = view.interpolation === "linear" && !pal;

  // Separable mapping: image x for each column, image y for each row.
  const ix = new Float64Array(width), iy = new Float64Array(height);
  for (let px = 0; px < width; px++) ix[px] = (px + 0.5 - cx) * inv + cols / 2;
  for (let py = 0; py < height; py++) iy[py] = (py + 0.5 - cy) * inv + rows / 2;

  if (frame.samplesPerPixel === 3) {
    const k = rgbScale(frame);
    const q = (v: number) => Math.floor(v * k + 0.5);
    for (let py = 0; py < height; py++) {
      const y = iy[py];
      for (let px = 0; px < width; px++) {
        const x = ix[px], o = py * width + px;
        if (x < 0 || y < 0 || x >= cols || y >= rows) { out32[o] = BLACK; continue; }
        let r, g, b;
        if (!linear) {
          const i = (Math.floor(y) * cols + Math.floor(x)) * 3;
          r = q(data[i]); g = q(data[i + 1]); b = q(data[i + 2]);
        } else {
          const s = bilinearSetup(x, y, cols, rows);
          r = q(bil(data, s, 3, 0)); g = q(bil(data, s, 3, 1)); b = q(bil(data, s, 3, 2));
        }
        out32[o] = BLACK | (b << 16) | (g << 8) | r;
      }
    }
    return out;
  }

  if (pal) {
    const p = frame.palette!;
    const n = p.rgba.length / 4;
    const lut32 = new Uint32Array(p.rgba.slice().buffer);
    for (let py = 0; py < height; py++) {
      const y = iy[py];
      for (let px = 0; px < width; px++) {
        const x = ix[px], o = py * width + px;
        if (x < 0 || y < 0 || x >= cols || y >= rows) { out32[o] = BLACK; continue; }
        const v = data[Math.floor(y) * cols + Math.floor(x)];
        out32[o] = lut32[Math.min(n - 1, Math.max(0, v - p.first))];
      }
    }
    return out;
  }

  const wl = wlParams(frame, view.windowCenter, view.windowWidth);
  const invert = isMonochrome1(frame) !== view.invert;
  // Level -> packed RGBA.
  const colour = new Uint32Array(256);
  for (let k = 0; k < 256; k++) {
    const kk = invert ? 255 - k : k;
    if (view.colormap) {
      const c = view.colormap;
      colour[k] = (c[kk * 4 + 3] << 24 >>> 0) | (c[kk * 4 + 2] << 16) | (c[kk * 4 + 1] << 8) | c[kk * 4];
    } else colour[k] = BLACK | (kk << 16) | (kk << 8) | kk;
  }

  if (!linear) {
    // Nearest: a table over the stored value range when it is small (8/16-bit), else per pixel.
    const table = valueTable(frame, wl);
    for (let py = 0; py < height; py++) {
      const y = iy[py];
      const yOut = y < 0 || y >= rows;
      const rowBase = Math.floor(y) * cols;
      for (let px = 0; px < width; px++) {
        const x = ix[px], o = py * width + px;
        if (yOut || x < 0 || x >= cols) { out32[o] = BLACK; continue; }
        const v = data[rowBase + Math.floor(x)];
        out32[o] = colour[table ? table.lut[v - table.lo] : levelOf(v, wl)];
      }
    }
    return out;
  }

  for (let py = 0; py < height; py++) {
    const y = iy[py];
    for (let px = 0; px < width; px++) {
      const x = ix[px], o = py * width + px;
      if (x < 0 || y < 0 || x >= cols || y >= rows) { out32[o] = BLACK; continue; }
      const v = bil(data, bilinearSetup(x, y, cols, rows), 1, 0);
      out32[o] = colour[levelOf(v, wl)];
    }
  }
  return out;
}

interface Bilinear { i00: number; i10: number; i01: number; i11: number; fx: number; fy: number }

function bilinearSetup(x: number, y: number, cols: number, rows: number): Bilinear {
  const tx = x - 0.5, ty = y - 0.5;
  const x0f = Math.floor(tx), y0f = Math.floor(ty);
  const fx = tx - x0f, fy = ty - y0f;
  const x0 = Math.min(cols - 1, Math.max(0, x0f)), x1 = Math.min(cols - 1, Math.max(0, x0f + 1));
  const y0 = Math.min(rows - 1, Math.max(0, y0f)), y1 = Math.min(rows - 1, Math.max(0, y0f + 1));
  return { i00: y0 * cols + x0, i10: y0 * cols + x1, i01: y1 * cols + x0, i11: y1 * cols + x1, fx, fy };
}

function bil(d: Samples, s: Bilinear, spp: number, c: number) {
  const top = d[s.i00 * spp + c] * (1 - s.fx) + d[s.i10 * spp + c] * s.fx;
  const bot = d[s.i01 * spp + c] * (1 - s.fx) + d[s.i11 * spp + c] * s.fx;
  return top * (1 - s.fy) + bot * s.fy;
}

/** Level for every possible stored value, for 8- and 16-bit data. */
function valueTable(frame: Frame, wl: WlParams): { lo: number; lut: Uint8Array } | null {
  if (frame.bitsAllocated > 16) return null;
  const bits = frame.bitsAllocated === 1 ? 8 : frame.bitsAllocated;
  const lo = frame.signed ? -(2 ** (bits - 1)) : 0;
  const n = 2 ** bits;
  const lut = new Uint8Array(n);
  for (let i = 0; i < n; i++) lut[i] = levelOf(lo + i, wl);
  return { lo, lut };
}

// ------------------------------------------------------------------------------ CPU renderer

export interface DrawTiming {
  /** Time spent producing the frame on the main thread (CPU: render + putImageData; GL: uniforms + draw call). */
  drawMs: number;
  /** From the first setView() since the last draw to the next animation frame after the draw. */
  frameMs: number;
}

export interface Renderer {
  readonly kind: "webgl2" | "cpu";
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly view: View;
  readonly frame: Frame | null;
  setFrame(frame: Frame, view?: Partial<View>): void;
  /** Merge into the view and redraw on the next animation frame. */
  setView(v: Partial<View>): void;
  /** Redraw now. */
  draw(): void;
  /** RGBA, top-left origin, of what is currently drawn (draws first). */
  readPixels(): Uint8Array;
  onDraw: ((t: DrawTiming) => void) | null;
  destroy(): void;
}

/** Mixin for rAF-coalesced redraws with timing. */
export abstract class ScheduledRenderer {
  view: View = defaultView();
  frame: Frame | null = null;
  onDraw: ((t: DrawTiming) => void) | null = null;
  private raf = 0;
  private since = 0;

  abstract draw(): void;

  setView(v: Partial<View>) {
    Object.assign(this.view, v);
    if (!this.since) this.since = performance.now();
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const t0 = performance.now();
      this.draw();
      const drawMs = performance.now() - t0;
      const since = this.since;
      this.since = 0;
      requestAnimationFrame(() => this.onDraw?.({ drawMs, frameMs: performance.now() - since }));
    });
  }

  protected cancel() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/** Fallback when WebGL2 is unavailable: renderCpu into a 2D canvas. Same pixels as the GL path. */
export class CpuRenderer extends ScheduledRenderer implements Renderer {
  readonly kind = "cpu" as const;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private image: ImageData | null = null;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    super();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  setFrame(frame: Frame, view?: Partial<View>) {
    this.frame = frame;
    if (view) Object.assign(this.view, view);
    this.draw();
  }

  draw() {
    const { width, height } = this.canvas;
    if (!this.image || this.image.width !== width || this.image.height !== height) this.image = new ImageData(width, height);
    if (this.frame) renderCpu(this.frame, this.view, width, height, this.image.data);
    else this.image.data.fill(0);
    this.ctx.putImageData(this.image, 0, 0);
  }

  readPixels(): Uint8Array {
    this.draw();
    return new Uint8Array(this.image!.data.buffer.slice(0));
  }

  destroy() {
    this.cancel();
    this.frame = null;
  }
}
