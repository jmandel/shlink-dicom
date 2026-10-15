// Volumes and multiplanar reformatting: a series of parallel, equally sized slices (single-frame
// images, or the frames of an enhanced multi-frame image) stacked in patient space, and planes cut
// through it along the other two axes, resampled to square pixels.
import type { DecodedImage, Frame, Samples } from "../../viewer-kit/src/index";
import { frameOf } from "../../viewer-kit/src/index";
import { floatFrame, floatRange, imageRealWorld } from "./display";
import { dot, normal, sub, type Geometry, type Vec3 } from "./geometry";

export interface VolumeInput {
  img: DecodedImage;
  frame: number;
  geom: Geometry;
}

export type Plane = "axial" | "sagittal" | "coronal";

export interface Volume {
  cols: number;
  rows: number;
  depth: number;
  /** mm: between columns, between rows, between slices. */
  spacing: [number, number, number];
  /** The plane the slices were acquired in. */
  acquired: Plane;
  /** Slices in increasing position along the normal. */
  slices: Frame[];
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;
}

export class VolumeError extends Error {}

/** The anatomical plane closest to an image plane, from its normal. */
export function planeOf(n: Vec3): Plane {
  const a = n.map(Math.abs);
  return a[2] >= a[0] && a[2] >= a[1] ? "axial" : a[0] >= a[1] ? "sagittal" : "coronal";
}

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
    if (s.img.samplesPerPixel !== 1) throw new VolumeError("colour images");
  }
  // Float slices become 16-bit frames over one shared real-value range, so they interpolate and window together.
  const floatSlices = input[0].img.float ? sharedRange(input) : null;
  const sorted = [...input].sort((a, b) => dot(sub(a.geom.position!, g0.position!), n) - dot(sub(b.geom.position!, g0.position!), n));
  const pos = sorted.map((s) => dot(sub(s.geom.position!, g0.position!), n));
  const gaps = pos.slice(1).map((p, i) => p - pos[i]);
  const dz = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!(dz > 1e-3)) throw new VolumeError("slices share a position");
  if (gaps.some((g) => Math.abs(g - dz) > Math.max(0.01, dz * 0.05))) throw new VolumeError("slices are not evenly spaced");
  return {
    cols: f0.columns,
    rows: f0.rows,
    depth: sorted.length,
    spacing: [g0.spacing[1], g0.spacing[0], dz],
    acquired: planeOf(n),
    slices: sorted.map((s) => frameOf(s.img, s.frame)).map((f, i) => (floatSlices ? floatFrame(f, imageRealWorld(sorted[i].img), floatSlices) : f)),
    rowDir: g0.row,
    colDir: g0.col,
    normalDir: n,
  };
}

/** The two planes to reformat into, and how many positions each has. */
export function reformatPlanes(v: Volume): { plane: Plane; count: number }[] {
  const out: { plane: Plane; count: number }[] = [];
  for (const p of ["axial", "sagittal", "coronal"] as Plane[]) {
    if (p === v.acquired) continue;
    out.push({ plane: p, count: cutAxis(v, p) === "col" ? v.cols : v.rows });
  }
  return out;
}

/** Which in-plane axis a reformat holds fixed: the one whose direction best matches the plane's normal. */
function cutAxis(v: Volume, p: Plane): "col" | "row" {
  const axis = p === "sagittal" ? 0 : p === "coronal" ? 1 : 2;
  // Fixing a column index moves along the row direction; fixing a row index along the column direction.
  return Math.abs(v.rowDir[axis]) >= Math.abs(v.colDir[axis]) ? "col" : "row";
}

/**
 * The plane at position `index` along the reformat axis, as a frame with square pixels: the
 * in-plane axis keeps its spacing, the slice axis is resampled (linear) to match it. Patient
 * superior (or anterior, for axial reformats of coronal stacks) is up.
 */
export function reformat(v: Volume, p: Plane, index: number): { frame: Frame; pixelSpacing: number } {
  const fixCol = cutAxis(v, p) === "col";
  const across = fixCol ? v.rows : v.cols; // samples along the kept in-plane axis
  const inSpacing = fixCol ? v.spacing[1] : v.spacing[0];
  const outRows = Math.max(1, Math.round(((v.depth - 1) * v.spacing[2]) / inSpacing) + 1);
  const proto = v.slices[0];
  const Ctor = proto.data.constructor as { new (n: number): Samples };
  const data = new Ctor(across * outRows);
  // Up is the direction of the normal's largest patient component pointing to +Z (head), else +Y? keep +Z/-Y conventions.
  const upAxis = p === "axial" ? 1 : 2;
  const normalUp = upAxis === 2 ? v.normalDir[2] > 0 : v.normalDir[1] < 0;
  for (let r = 0; r < outRows; r++) {
    const zf = outRows === 1 ? 0 : ((v.depth - 1) * r) / (outRows - 1);
    const z = normalUp ? v.depth - 1 - zf : zf;
    const z0 = Math.floor(z), z1 = Math.min(v.depth - 1, z0 + 1), t = z - z0;
    const a = v.slices[z0].data, b = v.slices[z1].data;
    for (let k = 0; k < across; k++) {
      const i = fixCol ? k * v.cols + index : index * v.cols + k;
      data[r * across + k] = Math.round(a[i] * (1 - t) + b[i] * t);
    }
  }
  return {
    frame: { ...proto, rows: outRows, columns: across, data, palette: null },
    pixelSpacing: inSpacing,
  };
}
