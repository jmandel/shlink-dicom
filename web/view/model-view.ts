// A small WebGL view of a triangle mesh (Encapsulated STL / OBJ): lit with a head light, turned by
// dragging, zoomed by pinch or wheel. Falls back to a message without WebGL.
import type { Mesh } from "../core/mesh";

const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec3 aCol;
uniform mat4 uMvp; uniform mat3 uRot;
out vec3 vNor; out vec3 vCol;
void main() { vNor = uRot * aNor; vCol = aCol; gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec3 vNor; in vec3 vCol; out vec4 o;
void main() {
  float d = abs(dot(normalize(vNor), vec3(0.0, 0.0, 1.0)));
  o = vec4(vCol * (0.25 + 0.75 * d), 1.0);
}`;

type M4 = Float32Array;
const mul = (a: M4, b: M4): M4 => {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    r[i * 4 + j] = s;
  }
  return r;
};
const rotX = (t: number): M4 => new Float32Array([1, 0, 0, 0, 0, Math.cos(t), Math.sin(t), 0, 0, -Math.sin(t), Math.cos(t), 0, 0, 0, 0, 1]);
const rotY = (t: number): M4 => new Float32Array([Math.cos(t), 0, -Math.sin(t), 0, 0, 1, 0, 0, Math.sin(t), 0, Math.cos(t), 0, 0, 0, 0, 1]);

export class ModelView {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private yaw = 0.6;
  private pitch = -0.4;
  private zoom = 1;
  private count = 0;
  private center: [number, number, number];
  private radius: number;
  private prog: WebGLProgram | null = null;
  private ro: ResizeObserver;

  constructor(holder: HTMLElement, mesh: Mesh) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "model-canvas";
    holder.append(this.canvas);
    this.center = [0, 1, 2].map((i) => (mesh.min[i] + mesh.max[i]) / 2) as [number, number, number];
    this.radius = Math.max(1e-6, Math.hypot(...mesh.max.map((m, i) => m - mesh.min[i])) / 2);
    this.gl = this.canvas.getContext("webgl2", { antialias: true });
    if (!this.gl) {
      holder.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "This browser can't show 3D models (no WebGL2). Download the file to open it elsewhere." }));
      this.ro = new ResizeObserver(() => {});
      return;
    }
    this.upload(mesh);
    this.wire();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(holder);
    this.draw();
  }

  private upload(m: Mesh) {
    const gl = this.gl!;
    const sh = (t: number, s: string) => {
      const x = gl.createShader(t)!;
      gl.shaderSource(x, s);
      gl.compileShader(x);
      return x;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const attr = (name: string, data: Float32Array) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    attr("aPos", m.positions);
    attr("aNor", m.normals);
    const col = m.colors ?? new Float32Array(m.positions.length).fill(0.82);
    attr("aCol", col);
    this.count = m.triangles * 3;
  }

  private wire() {
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 1) {
        this.yaw += dx * 0.01;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01));
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoom = Math.max(0.3, Math.min(8, this.zoom * (d / pinch)));
        pinch = d;
      }
      this.draw();
    });
    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.3, Math.min(8, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.draw();
    }, { passive: false });
  }

  draw() {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.1, 0.11, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    const s = this.zoom / this.radius;
    const aspect = w / h;
    // Model: centre, scale, rotate; orthographic projection keeps sizes honest.
    const t = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -this.center[0], -this.center[1], -this.center[2], 1]);
    const rot = mul(rotX(this.pitch), rotY(this.yaw));
    const proj = new Float32Array([s / Math.max(1, aspect), 0, 0, 0, 0, s * Math.min(1, aspect), 0, 0, 0, 0, -s * 0.5, 0, 0, 0, 0, 1]);
    const mvp = mul(proj, mul(rot, t));
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uMvp"), false, mvp);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.prog, "uRot"), false, new Float32Array([rot[0], rot[1], rot[2], rot[4], rot[5], rot[6], rot[8], rot[9], rot[10]]));
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    this.canvas.dataset.drawn = String(this.count / 3);
  }

  destroy() {
    this.ro.disconnect();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}
