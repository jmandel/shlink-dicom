// Volumes and multiplanar reformatting. A series of parallel, equally sized slices (single-frame
// images, or the frames of an enhanced multi-frame image) is a lattice in patient space: slice k's
// pixel (i, j) sits at origin + i·Δc·row + j·Δr·col + k·step, where `step` is the move from one
// slice to the next. With gantry tilt `step` is not along the slices' normal, and the lattice is
// sheared; it is still one affine map, so any plane can be sampled from it.
//
// A reformatted plane is a grid of points in patient space (true axial, sagittal or coronal,
// optionally turned and tilted), sampled with trilinear interpolation: the same rule as ITK's
// LinearInterpolateImageFunction, which display-checks.mjs uses as the oracle. A point is inside
// when its continuous index lies in [−0.5, n − 0.5) on each axis; neighbours past the edge take the
// edge value. Points outside are the volume's lowest value. A slab combines several parallel
// planes (maximum, minimum or mean) of the points that are inside.
import type { DecodedImage, Frame, Samples } from "../../viewer-kit/src/index";
import { frameOf } from "../../viewer-kit/src/index";
import { floatFrame, floatRange, imageRealWorld } from "./display";
import { cross, dot, normal, sub, type Geometry, type Vec3 } from "./geometry";

export interface VolumeInput {
  img: DecodedImage;
  frame: number;
  geom: Geometry;
  /** The header's rescale for this slice, when it gives one (it wins over the decoder's). */
  rescale?: { slope: number; intercept: number } | null;
}

export type Plane = "axial" | "sagittal" | "coronal";

export interface Volume {
  cols: number;
  rows: number;
  depth: number;
  /** mm between columns and between rows (in-plane). */
  spacing: [number, number];
  /** Patient position of slice 0, pixel (0, 0). */
  origin: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  /** Normal of the slices (row × col). */
  normalDir: Vec3;
  /** From one slice to the next (mm, patient space). Along normalDir unless the gantry was tilted. */
  step: Vec3;
  /** Slice spacing along the normal (mm). */
  sliceSpacing: number;
  /** Angle between `step` and the normal (degrees): the gantry tilt. */
  tilt: number;
  /** The plane the slices were acquired in. */
  acquired: Plane;
  /** Slices in increasing position along the normal. */
  slices: Frame[];
  /** Value used outside the volume (the lowest stored value). */
  background: number;
  /** Patient → continuous index: index = inverse · (p − origin). Row-major 3×3. */
  inverse: number[];
}

export class VolumeError extends Error {}

const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The anatomical plane closest to an image plane, from its normal. */
export function planeOf(n: Vec3): Plane {
  const a = n.map(Math.abs);
  return a[2] >= a[0] && a[2] >= a[1] ? "axial" : a[0] >= a[1] ? "sagittal" : "coronal";
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new VolumeError("the slices do not span a volume");
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Float slices become 16-bit frames over one shared real-value range, so they interpolate and window together. */
function sharedRange(input: VolumeInput[]): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const s of input) {
    const r = floatRange(s.img, imageRealWorld(s.img));
    if (r) {
      lo = Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
  }
  return lo <= hi ? { lo, hi } : null;
}

/** The lowest and highest real value (stored × the frame's own rescale) over the frames. */
function realRange(frames: Frame[]): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (const f of frames) {
    const d = f.data, m = f.rescaleSlope, b = f.rescaleIntercept;
    for (let i = 0; i < d.length; i++) {
      const v = d[i] * m + b;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? { lo, hi } : { lo: 0, hi: 1 };
}

/** Largest gantry tilt accepted (degrees): beyond it the slices barely overlap. */
const MAX_TILT = 45;

/** Stacks slices into a volume, or explains why they are not one. */
export function buildVolume(input: VolumeInput[]): Volume {
  if (input.length < 3) throw new VolumeError("fewer than 3 slices");
  const g0 = input[0].geom;
  if (!g0.row || !g0.col || !g0.position || !g0.spacing) throw new VolumeError("no position, orientation or spacing");
  const n = normal(g0)!;
  const f0 = frameOf(input[0].img, input[0].frame);
  for (const s of input) {
    const g = s.geom;
    if (!g.row || !g.col || !g.position || !g.spacing) throw new VolumeError("a slice lacks geometry");
    if (Math.abs(dot(g.row, g0.row) - 1) > 1e-3 || Math.abs(dot(g.col, g0.col) - 1) > 1e-3) throw new VolumeError("slices are not parallel");
    if (s.img.rows !== f0.rows || s.img.columns !== f0.columns) throw new VolumeError("slices differ in size");
    if (Math.abs(g.spacing[0] - g0.spacing[0]) > 1e-3 || Math.abs(g.spacing[1] - g0.spacing[1]) > 1e-3) throw new VolumeError("slices differ in pixel spacing");
    if (s.img.samplesPerPixel !== 1) throw new VolumeError("colour images");
  }
  const sorted = [...input].sort((a, b) => dot(sub(a.geom.position!, g0.position!), n) - dot(sub(b.geom.position!, g0.position!), n));
  const p0 = sorted[0].geom.position!;
  const pos = sorted.map((s) => dot(sub(s.geom.position!, p0), n));
  const dz = (pos[pos.length - 1] - pos[0]) / (pos.length - 1);
  if (!(dz > 1e-3)) throw new VolumeError("slices share a position");
  const gaps = pos.slice(1).map((p, i) => p - pos[i]);
  if (gaps.some((g) => Math.abs(g - dz) > Math.max(0.01, dz * 0.05))) throw new VolumeError("slices are not evenly spaced");
  // The step between slices, and how far each slice is from where that step puts it (tilt is a
  // constant in-plane shift per slice; anything else is not a lattice).
  const step = scale(sub(sorted[sorted.length - 1].geom.position!, p0), 1 / (sorted.length - 1));
  for (let k = 0; k < sorted.length; k++) {
    const off = sub(sorted[k].geom.position!, add(p0, scale(step, k)));
    if (norm(off) > Math.max(0.05, 0.05 * Math.min(g0.spacing[0], g0.spacing[1], dz))) throw new VolumeError("slice positions do not follow one direction");
  }
  const frames = sorted.map((s) => {
    const f = frameOf(s.img, s.frame);
    return s.rescale ? { ...f, rescaleSlope: s.rescale.slope, rescaleIntercept: s.rescale.intercept } : f;
  });
  let slices = frames;
  if (input[0].img.float) {
    const range = sharedRange(input);
    slices = frames.map((f, i) => floatFrame(f, imageRealWorld(sorted[i].img), range));
  } else if (frames.some((f) => f.rescaleSlope !== frames[0].rescaleSlope || f.rescaleIntercept !== frames[0].rescaleIntercept)) {
    // Each slice has its own rescale (PET): one shared scale of real values, so a reformat
    // crossing the slices shows the same quantity everywhere.
    const range = realRange(frames);
    slices = frames.map((f) => floatFrame(f, null, range));
  }
  return makeVolume(slices, p0, g0.row, g0.col, [g0.spacing[1], g0.spacing[0]], step);
}

/** A volume from slices already in order: slice 0's pixel (0, 0) at `origin`, `step` between slices. */
export function makeVolume(slices: Frame[], origin: Vec3, rowDir: Vec3, colDir: Vec3, spacing: [number, number], step: Vec3): Volume {
  const n = cross(rowDir, colDir);
  const dz = dot(step, n);
  const tilt = (Math.acos(Math.min(1, Math.abs(dz) / norm(step))) * 180) / Math.PI;
  if (tilt > MAX_TILT) throw new VolumeError(`the gantry tilt (${tilt.toFixed(0)}°) is too steep`);
  const [sc, sr] = spacing;
  let background = Infinity;
  for (const f of slices) for (let i = 0; i < f.data.length; i += 7) if (f.data[i] < background) background = f.data[i];
  // Index → patient: columns are Δc·row, Δr·col and step.
  const m = [rowDir[0] * sc, colDir[0] * sr, step[0], rowDir[1] * sc, colDir[1] * sr, step[1], rowDir[2] * sc, colDir[2] * sr, step[2]];
  return {
    cols: slices[0].columns,
    rows: slices[0].rows,
    depth: slices.length,
    spacing: [sc, sr],
    origin,
    rowDir,
    colDir,
    normalDir: n,
    step,
    sliceSpacing: dz,
    tilt,
    acquired: planeOf(n),
    slices,
    background: Number.isFinite(background) ? background : 0,
    inverse: invert3(m),
  };
}

// ----------------------------------------------------------------------------------- planes

/** A reformatted plane: true anatomical axes, then turned (about the screen's vertical) and tilted (about its horizontal), in degrees. */
export interface Orientation {
  plane: Plane;
  turn: number;
  tilt: number;
}

/** A stack of parallel output planes covering the volume. */
export interface PlaneGrid {
  /** Screen right, screen down and the scroll direction (u × v), unit vectors in patient space. */
  u: Vec3;
  v: Vec3;
  w: Vec3;
  /** Output pixel size (mm, square). */
  spacing: number;
  /** Distance between planes (mm). */
  step: number;
  width: number;
  height: number;
  /** Number of planes. */
  count: number;
  /** Patient position of pixel (0, 0) of plane 0. */
  origin: Vec3;
}

/** Screen axes of the true anatomical planes (LPS patient coordinates; radiological display). */
const AXES: Record<Plane, { u: Vec3; v: Vec3 }> = {
  // Patient left on screen right, anterior up.
  axial: { u: [1, 0, 0], v: [0, 1, 0] },
  // Patient left on screen right, superior up.
  coronal: { u: [1, 0, 0], v: [0, 0, -1] },
  // Posterior on screen right, superior up.
  sagittal: { u: [0, 1, 0], v: [0, 0, -1] },
};

function rotate(p: Vec3, axis: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const k = axis, d = dot(k, p), x = cross(k, p);
  return [p[0] * c + x[0] * s + k[0] * d * (1 - c), p[1] * c + x[1] * s + k[1] * d * (1 - c), p[2] * c + x[2] * s + k[2] * d * (1 - c)];
}

/** Screen axes for an orientation: turn about v, then tilt about the turned u. */
export function planeAxes(o: Orientation): { u: Vec3; v: Vec3; w: Vec3 } {
  let { u, v } = AXES[o.plane];
  if (o.turn) u = rotate(u, v, o.turn);
  if (o.tilt) v = rotate(v, u, o.tilt);
  return { u, v, w: cross(u, v) };
}

/** Patient position of index (i, j, k). */
export function indexToPatient(vol: Volume, i: number, j: number, k: number): Vec3 {
  const [sc, sr] = vol.spacing;
  return add(add(add(vol.origin, scale(vol.rowDir, i * sc)), scale(vol.colDir, j * sr)), scale(vol.step, k));
}

/**
 * The output grid for an orientation: pixels as fine as the finer in-plane spacing, planes as far
 * apart as the lattice is along the scroll direction, covering the volume's bounding box.
 */
export function planeGrid(vol: Volume, o: Orientation): PlaneGrid {
  const { u, v, w } = planeAxes(o);
  const spacing = Math.min(vol.spacing[0], vol.spacing[1]);
  // Lattice spacing along w: the finest of the three axes' spacings seen along w.
  const axes: [Vec3, number][] = [[vol.rowDir, vol.spacing[0]], [vol.colDir, vol.spacing[1]], [scale(vol.step, 1 / norm(vol.step)), norm(vol.step)]];
  let step = Infinity;
  for (const [d, s] of axes) {
    const c = Math.abs(dot(d, w));
    if (c > 1e-6) step = Math.min(step, s / c);
  }
  step = Math.max(step, spacing / 4);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of [0, vol.cols - 1]) for (const j of [0, vol.rows - 1]) for (const k of [0, vol.depth - 1]) {
    const p = indexToPatient(vol, i, j, k);
    [dot(p, u), dot(p, v), dot(p, w)].forEach((x, a) => {
      lo[a] = Math.min(lo[a], x);
      hi[a] = Math.max(hi[a], x);
    });
  }
  const width = Math.floor((hi[0] - lo[0]) / spacing + 1e-6) + 1;
  const height = Math.floor((hi[1] - lo[1]) / spacing + 1e-6) + 1;
  const count = Math.floor((hi[2] - lo[2]) / step + 1e-6) + 1;
  const origin = add(add(scale(u, lo[0]), scale(v, lo[1])), scale(w, lo[2]));
  return { u, v, w, spacing, step, width, height, count, origin };
}

/** The planes a series can be reformatted into, and how many positions each has. */
export function reformatPlanes(vol: Volume): { plane: Plane; count: number }[] {
  return (["axial", "sagittal", "coronal"] as Plane[]).map((plane) => ({ plane, count: planeGrid(vol, { plane, turn: 0, tilt: 0 }).count }));
}

/**
 * Whether plane `o` is exactly the stored slices (same axes, no tilt, no shear): then the stored
 * images are shown rather than a resampled copy.
 */
export function isAcquired(vol: Volume, o: Orientation): boolean {
  if (o.turn || o.tilt || vol.tilt > 1e-3) return false;
  const { u, v } = planeAxes(o);
  return dot(u, vol.rowDir) > 1 - 1e-6 && dot(v, vol.colDir) > 1 - 1e-6;
}

// ----------------------------------------------------------------------------------- sampling

export type SlabMode = "mip" | "minip" | "avg";

export interface Slab {
  /** Thickness (mm); 0 for a thin plane. */
  thickness: number;
  mode: SlabMode;
}

/** Offsets (mm, along w) of the planes a slab combines: n planes spanning the thickness, n − 1 steps no wider than the grid's. */
export function slabOffsets(g: PlaneGrid, slab?: Slab | null): number[] {
  if (!slab || !(slab.thickness > 0)) return [0];
  const n = Math.max(2, Math.ceil(slab.thickness / g.step - 1e-9) + 1);
  return Array.from({ length: n }, (_, k) => -slab.thickness / 2 + (k * slab.thickness) / (n - 1));
}

/** What a reformatted plane is, for checks and oracles: its pixel grid in patient space. */
export interface PlaneSpec {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  w: Vec3;
  spacing: number;
  width: number;
  height: number;
  offsets: number[];
  mode: SlabMode | null;
  background: number;
}

/** Patient position of pixel (0, 0) of plane `index`. */
export function planeStart(g: PlaneGrid, index: number): Vec3 {
  return add(g.origin, scale(g.w, index * g.step));
}

/**
 * Plane `index` of a grid (with a slab, if any) as a frame: stored values, typed like the slices
 * (rounded once, after combining), with the slices' rescale.
 */
export function reformat(vol: Volume, g: PlaneGrid, index: number, slab?: Slab | null): { frame: Frame; pixelSpacing: number; spec: PlaneSpec } {
  const W = g.width, H = g.height;
  const offsets = slabOffsets(g, slab);
  const mode = offsets.length > 1 ? slab!.mode : null;
  const base = planeStart(g, index);
  const acc = new Float64Array(W * H);
  const hits = new Uint16Array(W * H);
  const neg = vol.slices[0].rescaleSlope < 0;
  const useMax = mode === "mip" ? !neg : mode === "minip" ? neg : false;
  acc.fill(mode === null || mode === "avg" ? 0 : useMax ? -Infinity : Infinity);
  for (const off of offsets) sampleInto(vol, add(base, scale(g.w, off)), g.u, g.v, g.spacing, W, H, acc, hits, mode, useMax);
  return finishPlane(vol, g, index, slab, offsets, mode, acc, hits);
}

/** The frame from combined values and the count of points inside (CPU or GPU): rounded once; no point inside is the background. */
export function finishPlane(vol: Volume, g: PlaneGrid, index: number, slab: Slab | null | undefined, offsets: number[], mode: SlabMode | null, acc: Float64Array, hits: Uint16Array) {
  const proto = vol.slices[0];
  const Ctor = proto.data.constructor as { new (n: number): Samples };
  const W = g.width, H = g.height;
  const data = new Ctor(W * H);
  for (let p = 0; p < W * H; p++) {
    const n = hits[p];
    data[p] = n ? Math.round(mode === "avg" ? acc[p] / n : acc[p]) : vol.background;
  }
  return {
    frame: { ...proto, rows: H, columns: W, data, palette: null } as Frame,
    pixelSpacing: g.spacing,
    spec: { origin: planeStart(g, index), u: g.u, v: g.v, w: g.w, spacing: g.spacing, width: W, height: H, offsets, mode, background: vol.background } as PlaneSpec,
  };
}

/** Samples one plane into `acc` (thin: the value; slab: combined), counting the points inside. */
function sampleInto(vol: Volume, o: Vec3, u: Vec3, v: Vec3, s: number, W: number, H: number, acc: Float64Array, hits: Uint16Array, mode: SlabMode | null, useMax: boolean) {
  const M = vol.inverse;
  const { cols, rows, depth, slices } = vol;
  // Continuous index is affine in (x, y): i = i0 + x·di_x + y·di_y, and likewise for j and k.
  const d = sub(o, vol.origin);
  const ap = (a: Vec3): Vec3 => [M[0] * a[0] + M[1] * a[1] + M[2] * a[2], M[3] * a[0] + M[4] * a[1] + M[5] * a[2], M[6] * a[0] + M[7] * a[1] + M[8] * a[2]];
  const c0 = ap(d), cx = ap(scale(u, s)), cy = ap(scale(v, s));
  const datas = slices.map((f) => f.data);
  const iMax = cols - 0.5, jMax = rows - 0.5, kMax = depth - 0.5;
  for (let y = 0; y < H; y++) {
    let ci = c0[0] + y * cy[0], cj = c0[1] + y * cy[1], ck = c0[2] + y * cy[2];
    let p = y * W;
    for (let x = 0; x < W; x++, p++, ci += cx[0], cj += cx[1], ck += cx[2]) {
      if (ci < -0.5 || ci >= iMax || cj < -0.5 || cj >= jMax || ck < -0.5 || ck >= kMax) continue;
      let i0 = Math.floor(ci), j0 = Math.floor(cj), k0 = Math.floor(ck);
      const fi = ci - i0, fj = cj - j0, fk = ck - k0;
      let i1 = i0 + 1, j1 = j0 + 1, k1 = k0 + 1;
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (k0 < 0) k0 = 0;
      if (i1 > cols - 1) i1 = cols - 1;
      if (j1 > rows - 1) j1 = rows - 1;
      if (k1 > depth - 1) k1 = depth - 1;
      const a = datas[k0], b = datas[k1];
      const r0 = j0 * cols, r1 = j1 * cols;
      const va = (a[r0 + i0] * (1 - fi) + a[r0 + i1] * fi) * (1 - fj) + (a[r1 + i0] * (1 - fi) + a[r1 + i1] * fi) * fj;
      const vb = (b[r0 + i0] * (1 - fi) + b[r0 + i1] * fi) * (1 - fj) + (b[r1 + i0] * (1 - fi) + b[r1 + i1] * fi) * fj;
      const val = va * (1 - fk) + vb * fk;
      if (mode === null) acc[p] = val;
      else if (mode === "avg") acc[p] += val;
      else if (useMax ? val > acc[p] : val < acc[p]) acc[p] = val;
      hits[p]++;
    }
  }
}
