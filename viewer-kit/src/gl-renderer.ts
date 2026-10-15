// WebGL2 renderer for decoded DICOM frames.
//
// The frame is uploaded once, at full precision, as an integer texture:
//   8-bit  -> R8UI / R8I        16-bit -> R16UI / R16I        32-bit -> R32UI / R32I
//   RGB    -> RGB8UI (RGB16UI / RGB32UI for the rare 16/32-bit RGB)
// (R8UI rather than R8: the same integer path for every width, no normalisation.)
// and read with texelFetch through an integer sampler (usampler2D / isampler2D), so no value is
// ever normalised or rounded on upload. Integer textures cannot be filtered by the hardware, so
// "linear" is a manual bilinear over four texelFetch()es. The alternative, R32F with hardware
// LINEAR filtering, is exact for 16-bit integers too (float32 holds every integer below 2^24) but
// needs OES_texture_float_linear, which is optional in WebGL2, and twice the memory.
//
// Everything after the upload is uniforms: window/level, zoom, pan, interpolation, invert and the
// colour map only change uniforms and redraw. The pipeline is the one documented in
// cpu-render.ts, which is also the reference the shader is tested against (test/gl-vs-cpu.mjs).
//
// Context loss: the renderer keeps the Frame it was given (a view on the decoded buffer, no
// copy) and, on webglcontextrestored, recreates the programs and textures and re-uploads it.
import { CpuRenderer, ScheduledRenderer, isMonochrome1, rgbScale, usesPalette, viewScale, wlParams, type Renderer, type View } from "./cpu-render";
import type { Frame } from "./types";

const VS = `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = (signed: boolean) => `#version 300 es
precision highp float;
precision highp int;
precision highp ${signed ? "isampler2D" : "usampler2D"};
precision highp sampler2D;
uniform ${signed ? "isampler2D" : "usampler2D"} uImg;
uniform sampler2D uLut;
uniform ivec2 uSize;        // columns, rows
uniform vec2 uCentre;       // canvas centre + pan, canvas pixels, top-left origin
uniform float uInvScale;
uniform float uCanvasH;
uniform int uMode;          // 0 grey, 1 RGB, 2 palette
uniform int uLinear;
uniform int uXcI;           // window centre in stored units: integer part
uniform float uXcF;         //   and fraction
uniform float uA;
uniform float uB;
uniform int uThreshold;
uniform int uInvert;
uniform int uColormap;
uniform int uPalFirst;
uniform int uPalCount;
uniform int uWide;          // 32-bit samples: subtract in float (exact below 2^24 only)
uniform float uRgbScale;    // RGB: 255 / (2^BitsStored - 1), 1 for 8-bit
out vec4 outColor;

ivec4 fetchI(ivec2 p) { return ivec4(texelFetch(uImg, p, 0)); }
vec4 fetchF(ivec2 p) { return vec4(texelFetch(uImg, p, 0)); }

vec4 shade(float d) {
  float y = uThreshold == 1 ? (d * uA > 0.0 ? 1.0 : 0.0) : d * uA + uB;
  y = clamp(y, 0.0, 1.0);
  float k = floor(y * 255.0 + 0.5);
  if (uInvert == 1) k = 255.0 - k;
  if (uColormap == 1) return texelFetch(uLut, ivec2(int(k), 0), 0);
  return vec4(vec3(k / 255.0), 1.0);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
  vec2 img = (p - uCentre) * uInvScale + vec2(uSize) * 0.5;
  if (img.x < 0.0 || img.y < 0.0 || img.x >= float(uSize.x) || img.y >= float(uSize.y)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (uLinear == 0 || uMode == 2) {
    ivec2 q = ivec2(floor(img));
    if (uMode == 2) {
      int i = clamp(fetchI(q).r - uPalFirst, 0, uPalCount - 1);
      outColor = texelFetch(uLut, ivec2(i & 255, i >> 8), 0);
      return;
    }
    if (uMode == 1) {
      outColor = vec4(floor(fetchF(q).rgb * uRgbScale + 0.5) / 255.0, 1.0);
      return;
    }
    outColor = shade(uWide == 1 ? (fetchF(q).r - float(uXcI)) - uXcF : float(fetchI(q).r - uXcI) - uXcF);
    return;
  }
  vec2 t = img - 0.5;
  vec2 t0 = floor(t);
  vec2 f = t - t0;
  ivec2 a = ivec2(t0);
  ivec2 hi = uSize - 1;
  ivec2 a0 = clamp(a, ivec2(0), hi);
  ivec2 a1 = clamp(a + 1, ivec2(0), hi);
  vec4 v00 = fetchF(a0);
  vec4 v10 = fetchF(ivec2(a1.x, a0.y));
  vec4 v01 = fetchF(ivec2(a0.x, a1.y));
  vec4 v11 = fetchF(a1);
  vec4 top = v00 * (1.0 - f.x) + v10 * f.x;
  vec4 bot = v01 * (1.0 - f.x) + v11 * f.x;
  vec4 v = top * (1.0 - f.y) + bot * f.y;
  if (uMode == 1) {
    outColor = vec4(floor(v.rgb * uRgbScale + 0.5) / 255.0, 1.0);
    return;
  }
  outColor = shade((v.r - float(uXcI)) - uXcF);
}`;

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = ["uImg", "uLut", "uSize", "uCentre", "uInvScale", "uCanvasH", "uMode", "uLinear", "uXcI", "uXcF", "uA", "uB", "uThreshold", "uInvert", "uColormap", "uPalFirst", "uPalCount", "uWide", "uRgbScale"];

export interface GlRendererOptions {
  /** Passed to getContext("webgl2"). */
  contextAttributes?: WebGLContextAttributes;
}

export class GlRenderer extends ScheduledRenderer implements Renderer {
  readonly kind = "webgl2" as const;
  private gl!: WebGL2RenderingContext;
  private programs: { u?: Program; i?: Program } = {};
  private tex: WebGLTexture | null = null;
  private lut: WebGLTexture | null = null;
  private lutKey: unknown = undefined;
  private vao: WebGLVertexArrayObject | null = null;
  private lost = false;
  private signedTex = false;

  /** Returns null when WebGL2 is unavailable (use CpuRenderer, or createRenderer()). */
  static create(canvas: HTMLCanvasElement | OffscreenCanvas, opts: GlRendererOptions = {}): GlRenderer | null {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      ...opts.contextAttributes,
    }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    return new GlRenderer(canvas, gl);
  }

  private constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, gl: WebGL2RenderingContext) {
    super();
    this.gl = gl;
    this.init();
    canvas.addEventListener("webglcontextlost", this.onLost as EventListener);
    canvas.addEventListener("webglcontextrestored", this.onRestored as EventListener);
  }

  /** Renderer and vendor strings, when the browser exposes them. */
  get gpu(): string {
    const ext = this.gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(this.gl.getParameter(this.gl.RENDERER));
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  get contextLost(): boolean {
    return this.lost;
  }

  private onLost = (e: Event) => {
    e.preventDefault(); // allow restoration
    this.lost = true;
    this.cancel();
  };

  private onRestored = () => {
    this.lost = false;
    this.programs = {};
    this.tex = this.lut = null;
    this.lutKey = undefined;
    this.init();
    if (this.frame) this.upload(this.frame);
    this.draw();
  };

  private init() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  private program(signed: boolean): Program {
    const key = signed ? "i" : "u";
    const have = this.programs[key];
    if (have) return have;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS(signed)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    const u: Program["u"] = {};
    for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
    return (this.programs[key] = { prog, u });
  }

  setFrame(frame: Frame, view?: Partial<View>) {
    this.frame = frame;
    if (view) Object.assign(this.view, view);
    if (!this.lost) {
      this.upload(frame);
      this.draw();
    }
  }

  private upload(frame: Frame) {
    const gl = this.gl;
    const max = this.maxTextureSize;
    if (frame.columns > max || frame.rows > max) throw new RangeError(`image ${frame.columns}×${frame.rows} exceeds MAX_TEXTURE_SIZE ${max}; use CpuRenderer`);
    const signed = frame.signed && frame.samplesPerPixel === 1;
    let internal: number, format: number, type: number;
    if (frame.samplesPerPixel === 3) {
      const t: Record<number, [number, number]> = { 8: [gl.RGB8UI, gl.UNSIGNED_BYTE], 16: [gl.RGB16UI, gl.UNSIGNED_SHORT], 32: [gl.RGB32UI, gl.UNSIGNED_INT] };
      if (!t[frame.bitsAllocated]) throw new Error(`RGB with Bits Allocated ${frame.bitsAllocated}`);
      [internal, type] = t[frame.bitsAllocated];
      format = gl.RGB_INTEGER;
    } else {
      const bits = frame.bitsAllocated === 1 ? 8 : frame.bitsAllocated;
      const table: Record<number, [number, number, number, number, number]> = {
        8: [gl.R8UI, gl.UNSIGNED_BYTE, gl.R8I, gl.BYTE, 0],
        16: [gl.R16UI, gl.UNSIGNED_SHORT, gl.R16I, gl.SHORT, 0],
        32: [gl.R32UI, gl.UNSIGNED_INT, gl.R32I, gl.INT, 0],
      };
      const t = table[bits];
      if (!t) throw new Error(`Bits Allocated ${frame.bitsAllocated}`);
      [internal, type] = signed ? [t[2], t[3]] : [t[0], t[1]];
      format = gl.RED_INTEGER;
    }
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // Integer textures are only complete with NEAREST filtering; texelFetch ignores it anyway.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, frame.columns, frame.rows);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.columns, frame.rows, format, type, frame.data as ArrayBufferView);
    this.signedTex = signed;
    this.lutKey = undefined;
  }

  /** Colour map (256 entries) or palette (any count, laid out 256 per row) as RGBA8. */
  private bindLut(rgba: Uint8Array | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    if (rgba === this.lutKey && this.lut) {
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      return;
    }
    if (!this.lut) this.lut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const n = rgba ? rgba.length / 4 : 1;
    const h = Math.ceil(n / 256);
    const padded = new Uint8Array(256 * h * 4);
    if (rgba) padded.set(rgba);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
    this.lutKey = rgba;
  }

  draw() {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    const f = this.frame;
    if (!f || !this.tex) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const v = this.view;
    const p = this.program(this.signedTex);
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const pal = usesPalette(f);
    const mode = f.samplesPerPixel === 3 ? 1 : pal ? 2 : 0;
    const lutData = mode === 2 ? f.palette!.rgba : mode === 0 ? v.colormap : null;
    this.bindLut(lutData);
    const wl = wlParams(f, v.windowCenter, v.windowWidth);
    const u = p.u;
    gl.uniform1i(u.uImg, 0);
    gl.uniform1i(u.uLut, 1);
    gl.uniform2i(u.uSize, f.columns, f.rows);
    gl.uniform2f(u.uCentre, width / 2 + v.panX, height / 2 + v.panY);
    gl.uniform1f(u.uInvScale, 1 / viewScale(f, v, width, height));
    gl.uniform1f(u.uCanvasH, height);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1i(u.uLinear, v.interpolation === "linear" ? 1 : 0);
    gl.uniform1i(u.uXcI, wl.xcI);
    gl.uniform1f(u.uXcF, wl.xcF);
    gl.uniform1f(u.uA, wl.a);
    gl.uniform1f(u.uB, wl.b);
    gl.uniform1i(u.uThreshold, wl.threshold ? 1 : 0);
    gl.uniform1i(u.uInvert, isMonochrome1(f) !== v.invert ? 1 : 0);
    gl.uniform1i(u.uColormap, mode === 0 && v.colormap ? 1 : 0);
    gl.uniform1i(u.uPalFirst, pal ? f.palette!.first : 0);
    gl.uniform1i(u.uPalCount, pal ? f.palette!.rgba.length / 4 : 1);
    gl.uniform1i(u.uWide, f.bitsAllocated === 32 ? 1 : 0);
    gl.uniform1f(u.uRgbScale, rgbScale(f));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Wait until the GPU has finished the last draw (for benchmarks). gl.finish() does not block in
   * Chromium; reading back one pixel does.
   */
  finish() {
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
  }
  private px = new Uint8Array(4);

  readPixels(): Uint8Array {
    this.draw();
    const gl = this.gl;
    const { width, height } = this.canvas;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // Flip to top-left origin.
    const out = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) out.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out;
  }

  /** For tests: lose and restore the context through WEBGL_lose_context. */
  simulateContextLoss(): { lose(): void; restore(): void } | null {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    return ext ? { lose: () => ext.loseContext(), restore: () => ext.restoreContext() } : null;
  }

  destroy() {
    this.cancel();
    this.canvas.removeEventListener("webglcontextlost", this.onLost as EventListener);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored as EventListener);
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.lut) gl.deleteTexture(this.lut);
    for (const p of Object.values(this.programs)) if (p) gl.deleteProgram(p.prog);
    this.frame = null;
  }
}

let softwareGl: boolean | undefined;

/**
 * True when WebGL2 is backed by SwiftShader (Chromium's CPU rasteriser, used when the GPU is
 * blocklisted or absent). There the shader runs on the CPU and is slower than CpuRenderer
 * (PERF.md). Probed once on a throwaway canvas.
 */
export function isSwiftShader(): boolean {
  if (softwareGl !== undefined) return softwareGl;
  try {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    softwareGl = /swiftshader/i.test(name);
  } catch {
    softwareGl = false;
  }
  return softwareGl;
}

/**
 * GL renderer when WebGL2 works on a real GPU, else the CPU fallback (identical pixels).
 * `allowSoftwareGl: true` keeps WebGL even on SwiftShader.
 */
export function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, opts: GlRendererOptions & { forceCpu?: boolean; allowSoftwareGl?: boolean } = {}): Renderer {
  const useGl = !opts.forceCpu && (opts.allowSoftwareGl || !isSwiftShader());
  return (useGl && GlRenderer.create(canvas, opts)) || new CpuRenderer(canvas);
}
