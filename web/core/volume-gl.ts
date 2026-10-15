// Reformatting on the GPU: the volume as one integer 3D texture (uploaded once, at full
// precision), each output plane drawn by a fragment shader that does what volume.ts does on the
// CPU (same lattice, inside rule, edge clamping, trilinear weights, slab rule) in float32, into a
// float target read back as values and counts. volume.ts finishes the frame (rounding, background),
// so both paths give the same kind of frame; display-checks.mjs holds both to the oracle.
import type { Samples } from "../../viewer-kit/src/index";
import { finishPlane, planeStart, slabOffsets, type PlaneGrid, type Slab, type Volume } from "./volume";
import type { Vec3 } from "./geometry";

const MAX_PLANES = 256;

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = (sampler: string) => `#version 300 es
precision highp float;
precision highp int;
precision highp ${sampler};
uniform ${sampler} uVol;
uniform ivec3 uSize;
uniform vec3 uC0;
uniform vec3 uCx;
uniform vec3 uCy;
uniform vec3 uCw;
uniform int uN;
uniform float uOff0;
uniform float uOffStep;
uniform int uMode; // 0 thin, 1 larger wins, 2 smaller wins, 3 mean
out vec4 outV;
float at(ivec3 p) { return float(texelFetch(uVol, p, 0).r); }
void main() {
  vec2 xy = floor(gl_FragCoord.xy);
  float acc = uMode == 1 ? -3.0e38 : (uMode == 2 ? 3.0e38 : 0.0);
  float hits = 0.0;
  vec3 hi = vec3(uSize) - 0.5;
  for (int k = 0; k < ${MAX_PLANES}; k++) {
    if (k >= uN) break;
    vec3 c = uC0 + xy.x * uCx + xy.y * uCy + (uOff0 + float(k) * uOffStep) * uCw;
    if (c.x < -0.5 || c.y < -0.5 || c.z < -0.5 || c.x >= hi.x || c.y >= hi.y || c.z >= hi.z) continue;
    vec3 f0 = floor(c);
    vec3 f = c - f0;
    ivec3 a = ivec3(f0);
    ivec3 b = min(a + 1, uSize - 1);
    a = max(a, ivec3(0));
    float va = (at(ivec3(a.x, a.y, a.z)) * (1.0 - f.x) + at(ivec3(b.x, a.y, a.z)) * f.x) * (1.0 - f.y)
             + (at(ivec3(a.x, b.y, a.z)) * (1.0 - f.x) + at(ivec3(b.x, b.y, a.z)) * f.x) * f.y;
    float vb = (at(ivec3(a.x, a.y, b.z)) * (1.0 - f.x) + at(ivec3(b.x, a.y, b.z)) * f.x) * (1.0 - f.y)
             + (at(ivec3(a.x, b.y, b.z)) * (1.0 - f.x) + at(ivec3(b.x, b.y, b.z)) * f.x) * f.y;
    float v = va * (1.0 - f.z) + vb * f.z;
    if (uMode == 0) acc = v;
    else if (uMode == 3) acc += v;
    else if (uMode == 1 ? v > acc : v < acc) acc = v;
    hits += 1.0;
  }
  outV = vec4(acc, hits, 0.0, 1.0);
}`;

/** Integer texture format for the slices' sample type. */
function format(gl: WebGL2RenderingContext, d: Samples): { internal: number; type: number; sampler: string } | null {
  if (d instanceof Int16Array) return { internal: gl.R16I, type: gl.SHORT, sampler: "isampler3D" };
  if (d instanceof Uint16Array) return { internal: gl.R16UI, type: gl.UNSIGNED_SHORT, sampler: "usampler3D" };
  if (d instanceof Int8Array) return { internal: gl.R8I, type: gl.BYTE, sampler: "isampler3D" };
  if (d instanceof Uint8Array) return { internal: gl.R8UI, type: gl.UNSIGNED_BYTE, sampler: "usampler3D" };
  if (d instanceof Int32Array) return { internal: gl.R32I, type: gl.INT, sampler: "isampler3D" };
  if (d instanceof Uint32Array) return { internal: gl.R32UI, type: gl.UNSIGNED_INT, sampler: "usampler3D" };
  return null;
}

export class GpuReformatter {
  private constructor(
    private gl: WebGL2RenderingContext,
    private prog: WebGLProgram,
    private tex: WebGLTexture,
    private vol: Volume,
    readonly uploadMs: number,
  ) {}

  /** The GPU path for a volume, or null (no WebGL2 or float targets, texture too large, out of memory). */
  static create(vol: Volume): GpuReformatter | null {
    const t0 = performance.now();
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
    const f = format(gl, vol.slices[0].data);
    const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (!f || vol.cols > max3d || vol.rows > max3d || vol.depth > max3d) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS(f.sampler)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage3D(gl.TEXTURE_3D, 1, f.internal, vol.cols, vol.rows, vol.depth);
    for (let k = 0; k < vol.depth; k++) {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, vol.cols, vol.rows, 1, gl.RED_INTEGER, f.type, vol.slices[k].data as ArrayBufferView);
    }
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      return null;
    }
    return new GpuReformatter(gl, prog, tex, vol, performance.now() - t0);
  }

  /** Plane `index` of a grid (with a slab): the same frame volume.ts's reformat returns. */
  reformat(g: PlaneGrid, index: number, slab?: Slab | null) {
    const gl = this.gl, vol = this.vol;
    const W = g.width, H = g.height;
    const offsets = slabOffsets(g, slab);
    if (offsets.length > MAX_PLANES) return null;
    const mode = offsets.length > 1 ? slab!.mode : null;
    const neg = vol.slices[0].rescaleSlope < 0;
    const useMax = mode === "mip" ? !neg : mode === "minip" ? neg : false;
    const target = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.tex);
    const u = (n: string) => gl.getUniformLocation(this.prog, n);
    const M = vol.inverse;
    const ap = (a: Vec3): Vec3 => [M[0] * a[0] + M[1] * a[1] + M[2] * a[2], M[3] * a[0] + M[4] * a[1] + M[5] * a[2], M[6] * a[0] + M[7] * a[1] + M[8] * a[2]];
    const start = planeStart(g, index);
    const c0 = ap([start[0] - vol.origin[0], start[1] - vol.origin[1], start[2] - vol.origin[2]]);
    gl.uniform1i(u("uVol"), 0);
    gl.uniform3i(u("uSize"), vol.cols, vol.rows, vol.depth);
    gl.uniform3fv(u("uC0"), c0);
    gl.uniform3fv(u("uCx"), ap([g.u[0] * g.spacing, g.u[1] * g.spacing, g.u[2] * g.spacing]));
    gl.uniform3fv(u("uCy"), ap([g.v[0] * g.spacing, g.v[1] * g.spacing, g.v[2] * g.spacing]));
    gl.uniform3fv(u("uCw"), ap(g.w));
    gl.uniform1i(u("uN"), offsets.length);
    gl.uniform1f(u("uOff0"), offsets[0]);
    gl.uniform1f(u("uOffStep"), offsets.length > 1 ? offsets[1] - offsets[0] : 0);
    gl.uniform1i(u("uMode"), mode === null ? 0 : mode === "avg" ? 3 : useMax ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Float32Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(target);
    const acc = new Float64Array(W * H), hits = new Uint16Array(W * H);
    for (let p = 0; p < W * H; p++) {
      acc[p] = px[p * 4];
      hits[p] = px[p * 4 + 1];
    }
    return finishPlane(vol, g, index, slab, offsets, mode, acc, hits);
  }

  destroy() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteProgram(this.prog);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
