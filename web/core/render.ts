// Renderer adapter: viewer-kit's WebGL2 renderer with the CPU fallback, sized to its container,
// and CPU thumbnails (no WebGL context per thumbnail).
import {
  CpuRenderer,
  createRenderer,
  defaultView,
  frameOf,
  renderCpu,
  type DecodedImage,
  type Frame,
  type Renderer,
  type View,
} from "../../viewer-kit/src/index";
import { autoWindow } from "./wl";
import { floatFrame, floatRange, imageRealWorld, linearWindow } from "./display";

export type { View };

export interface ViewportOptions {
  /** Force the CPU renderer. */
  forceCpu?: boolean;
  /** Use WebGL even on SwiftShader (slower than the CPU path; for measurements). */
  allowSoftwareGl?: boolean;
  /** Cap on devicePixelRatio for the canvas backing store (default 2). */
  maxDpr?: number;
}

/**
 * A canvas filling `container`, kept at container size × devicePixelRatio. Window/level, zoom and
 * pan are uniforms on the GL path, so changing them never re-decodes or re-uploads.
 */
export class Viewport {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  /** The image and frame on screen. */
  image: DecodedImage | null = null;
  frameIndex = 0;
  onDraw: ((ms: number) => void) | null = null;
  private ro: ResizeObserver;

  constructor(
    readonly container: HTMLElement,
    private opts: ViewportOptions = {},
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vp-canvas";
    container.appendChild(this.canvas);
    this.renderer = this.make(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  get kind() {
    return this.renderer.kind;
  }
  get view(): View {
    return this.renderer.view;
  }

  private make(canvas: HTMLCanvasElement): Renderer {
    const r = createRenderer(canvas, { forceCpu: this.opts.forceCpu, allowSoftwareGl: this.opts.allowSoftwareGl });
    r.onDraw = (t) => this.onDraw?.(t.drawMs);
    return r;
  }

  resize() {
    const dpr = Math.min(this.opts.maxDpr ?? 2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.container.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.renderer.frame) this.renderer.draw();
    }
  }

  /** Canvas pixels per CSS pixel (for converting pointer moves to pan). */
  get scale() {
    return this.canvas.width / Math.max(1, this.canvas.clientWidth);
  }

  /**
   * Shows frame `k` of an image. `view` merges into the current view (window, zoom…). `frame`
   * replaces the decoded frame with a transformed one (display.ts: Modality LUT, VOI LUT…).
   */
  show(img: DecodedImage, k = 0, view: Partial<View> = {}, frame?: Frame) {
    const t0 = performance.now();
    const f = frame ?? frameOf(img, k);
    this.image = img;
    this.frameIndex = k;
    try {
      this.renderer.setFrame(f, view);
    } catch (e) {
      if (!(e instanceof RangeError) || this.renderer.kind !== "webgl2") throw e;
      // Larger than MAX_TEXTURE_SIZE: swap to the CPU renderer on a fresh canvas
      // (a canvas keeps its first context type).
      const v = { ...this.renderer.view };
      this.renderer.destroy();
      const n = this.canvas.cloneNode() as HTMLCanvasElement;
      this.canvas.replaceWith(n);
      this.canvas = n;
      this.renderer = new CpuRenderer(n);
      this.renderer.onDraw = (t) => this.onDraw?.(t.drawMs);
      Object.assign(this.renderer.view, v);
      this.resize();
      this.renderer.setFrame(f, view);
    }
    this.renderer.draw();
    // Upload + draw time on the main thread (setView redraws report through renderer.onDraw).
    this.onDraw?.(performance.now() - t0);
  }

  /** Uniform-only change, drawn on the next animation frame. */
  setView(v: Partial<View>) {
    this.renderer.setView(v);
  }

  destroy() {
    this.ro.disconnect();
    this.renderer.destroy();
    this.canvas.remove();
  }
}

/** Draws a thumbnail of an image on a 2D canvas with the CPU renderer (fit, auto window). */
export function drawThumbnail(canvas: HTMLCanvasElement, img: DecodedImage, k = 0) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const im = ctx.createImageData(w, h);
  // Float images: a 16-bit frame of real values, windowed as LINEAR_EXACT (display.ts).
  const rw = img.float ? imageRealWorld(img) : null;
  const auto = autoWindow(img, k, rw);
  const win = img.float ? linearWindow("LINEAR_EXACT", auto.center, auto.width) : auto;
  const frame = img.float ? floatFrame(frameOf(img, k), rw, floatRange(img, rw)) : frameOf(img, k);
  renderCpu(frame, { ...defaultView(), windowCenter: win.center, windowWidth: win.width, interpolation: "linear" }, w, h, im.data);
  ctx.putImageData(im, 0, 0);
}
