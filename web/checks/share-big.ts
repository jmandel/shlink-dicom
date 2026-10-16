// A multi-GB synthetic CT for the Share size checks: `n` slices of size² 16-bit pixels, one Part 10
// file each (explicit VR little endian), written to <dir>. Fictional patient; everything (pixels and
// UIDs) comes from a fixed seed, so two runs write the same files. The phantom is built to compress
// like real CT: air around the body, fat, muscle and organs, lungs, a spine, and Gaussian noise
// correlated over a few pixels as a reconstruction kernel makes it, so JPEG Lossless SV1 shrinks it
// about 2.7 times (Josh's CT: 2.74×).
//   bun web/checks/share-big.ts <dir> [slices=1600] [size=1024]
// Prints JSON: { dir, files, bytes, studyUid }. Reuses the files if <dir>/done.json matches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Version of the phantom: files made by an earlier generator are made again. */
const PHANTOM = 3;
/**
 * Noise scale against the region SDs below, and the radius of its smoothing (its correlation length,
 * in pixels). Tuned on 20 slices across the body: JPEG Lossless SV1 2.73×, JPEG 2000 Lossless 3.11×
 * (Josh's CT: 2.74× and 3.54×).
 */
const NOISE = 2;
const R = 2;

const [dir, nArg, sizeArg] = process.argv.slice(2);
const n = Number(nArg ?? 1600), size = Number(sizeArg ?? 1024);
const done = `${dir}/done.json`;
if (existsSync(done)) {
  const d = JSON.parse(readFileSync(done, "utf8"));
  if (d.slices === n && d.size === size && d.phantom === PHANTOM) {
    console.log(JSON.stringify(d));
    process.exit(0);
  }
}
mkdirSync(dir, { recursive: true });

const enc = new TextEncoder();
function el(out: number[], g: number, e: number, vr: string, value: string | Uint8Array) {
  const v = typeof value === "string" ? Array.from(enc.encode(value)) : Array.from(value);
  if (v.length % 2) v.push(vr === "UI" || vr === "OB" ? 0 : 0x20);
  out.push(g & 0xff, g >> 8, e & 0xff, e >> 8, vr.charCodeAt(0), vr.charCodeAt(1));
  if (vr === "OB") out.push(0, 0, v.length & 0xff, (v.length >> 8) & 0xff, (v.length >> 16) & 0xff, v.length >>> 24);
  else out.push(v.length & 0xff, v.length >> 8);
  out.push(...v);
}
const us = (x: number) => new Uint8Array([x & 0xff, x >> 8]);

/** A seeded generator (mulberry32): the same sequence on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uidRng = rng(20261015);
/** A 2.25 UID from the seeded generator. */
function uid(): string {
  let x = 0n;
  for (let i = 0; i < 4; i++) x = (x << 32n) | BigInt(Math.floor(uidRng() * 4294967296));
  return `2.25.${x % (1n << 125n)}`;
}

/** Normal deviates (Box-Muller), from a seeded generator. */
function gauss(r: () => number) {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = Math.max(r(), 1e-12), v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

const studyUid = uid(), seriesUid = uid();
const CT = "1.2.840.10008.5.1.4.1.1.2";

/**
 * Noise as CT has it: correlated between neighbouring pixels (the reconstruction kernel), here white
 * Gaussian noise averaged over a (2R+1)² box, scaled back to unit SD.
 */
function noiseField(k: number): Float32Array {
  const g = gauss(rng(1000 + k));
  const w = new Float32Array(size * size);
  for (let i = 0; i < w.length; i++) w[i] = g();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let t = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) t += w[Math.min(size - 1, Math.max(0, y + dy)) * size + Math.min(size - 1, Math.max(0, x + dx))];
      out[y * size + x] = t / (2 * R + 1);
    }
  return out;
}

/** One axial slice of the phantom at z (0…1, head to feet), in HU, with noise. */
function slice(z: number, k: number): Int16Array {
  const px = new Int16Array(size * size);
  const noise = noiseField(k);
  // Shapes change along the body: the trunk widens, lungs give way to abdomen, organs come and go.
  const bodyA = 0.4 + 0.04 * Math.sin(Math.PI * z), bodyB = 0.29 + 0.03 * Math.sin(Math.PI * z);
  const lung = Math.max(0, 1 - z * 2.2); // lungs in the upper part
  const liver = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (z - 0.25) / 0.4))));
  const kidney = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (z - 0.4) / 0.3))));
  for (let y = 0; y < size; y++) {
    const v = (y - size / 2) / size;
    for (let x = 0; x < size; x++) {
      const u = (x - size / 2) / size;
      const body = (u / bodyA) ** 2 + (v / bodyB) ** 2;
      let hu: number, sd: number;
      if (body >= 1) {
        // Air, and the table under the patient.
        hu = v > bodyB + 0.03 && v < bodyB + 0.045 && Math.abs(u) < 0.45 ? 200 : -1000;
        sd = 6;
      } else {
        // Subcutaneous fat, then muscle and soft tissue with a slow texture.
        const inner = (u / (bodyA - 0.035)) ** 2 + (v / (bodyB - 0.03)) ** 2;
        hu = inner >= 1 ? -100 : 45 + 8 * Math.sin(40 * u + 3 * z) * Math.cos(33 * v - 2 * z);
        sd = 14;
        // Lungs, with vessels.
        for (const s of [-1, 1]) {
          const lu = (u - s * 0.16) / (0.13 * lung + 1e-6), lv = (v + 0.02) / (0.19 * lung + 1e-6);
          if (lung > 0 && lu * lu + lv * lv < 1) {
            hu = -850 + (Math.sin(90 * u + 7 * z) * Math.sin(80 * v) > 0.93 ? 800 : 0);
            sd = 18;
          }
        }
        // Liver (right of the patient, left of the image) and spleen.
        if (liver > 0 && ((u + 0.13) / (0.17 * liver)) ** 2 + ((v + 0.02) / (0.15 * liver)) ** 2 < 1) hu = 62;
        if (liver > 0 && ((u - 0.2) / (0.07 * liver)) ** 2 + ((v - 0.06) / (0.08 * liver)) ** 2 < 1) hu = 50;
        // Kidneys, with their sinus fat.
        for (const s of [-1, 1]) {
          const ku = (u - s * 0.12) / (0.05 * kidney + 1e-6), kv = (v - 0.12) / (0.07 * kidney + 1e-6);
          if (kidney > 0 && ku * ku + kv * kv < 1) hu = ku * ku + kv * kv < 0.15 ? -60 : 150;
        }
        // Aorta, contrast-filled.
        if ((u / 0.022) ** 2 + ((v - 0.05) / 0.022) ** 2 < 1) hu = 220;
        // Vertebra: cortical rim and marrow.
        const sp = (u / 0.05) ** 2 + ((v - 0.17) / 0.045) ** 2;
        if (sp < 1) hu = sp > 0.7 ? 1100 : 280;
        // Bowel gas pockets in the lower abdomen.
        if (z > 0.55 && Math.sin(60 * u + 9 * z) * Math.cos(55 * v + 5 * z) > 0.97) hu = -950;
      }
      px[y * size + x] = Math.max(-1024, Math.min(3071, Math.round(hu + sd * NOISE * noise[y * size + x])));
    }
  }
  return px;
}

let bytes = 0;
for (let z = 0; z < n; z++) {
  const px = slice(z / Math.max(1, n - 1), z);
  const sop = uid();
  const meta: number[] = [];
  el(meta, 2, 1, "OB", new Uint8Array([0, 1]));
  el(meta, 2, 2, "UI", CT);
  el(meta, 2, 3, "UI", sop);
  el(meta, 2, 0x10, "UI", "1.2.840.10008.1.2.1");
  el(meta, 2, 0x12, "UI", "2.25.1");
  const gl: number[] = [];
  el(gl, 2, 0, "UL", new Uint8Array(new Uint32Array([meta.length]).buffer));
  const ds: number[] = [];
  el(ds, 8, 0x16, "UI", CT);
  el(ds, 8, 0x18, "UI", sop);
  el(ds, 8, 0x20, "DA", "20260101");
  el(ds, 8, 0x50, "SH", "SYNBIG01");
  el(ds, 8, 0x60, "CS", "CT");
  el(ds, 8, 0x1030, "LO", "Synthetic large CT");
  el(ds, 8, 0x103e, "LO", `Axial ${size}x${size}`);
  el(ds, 0x10, 0x10, "PN", "TEST^SYNTHETIC");
  el(ds, 0x10, 0x20, "LO", "SYN0002");
  el(ds, 0x20, 0x0d, "UI", studyUid);
  el(ds, 0x20, 0x0e, "UI", seriesUid);
  el(ds, 0x20, 0x11, "IS", "1");
  el(ds, 0x20, 0x13, "IS", String(z + 1));
  el(ds, 0x28, 2, "US", us(1));
  el(ds, 0x28, 4, "CS", "MONOCHROME2");
  el(ds, 0x28, 0x10, "US", us(size));
  el(ds, 0x28, 0x11, "US", us(size));
  el(ds, 0x28, 0x100, "US", us(16));
  el(ds, 0x28, 0x101, "US", us(16));
  el(ds, 0x28, 0x102, "US", us(15));
  el(ds, 0x28, 0x103, "US", us(1));
  el(ds, 0x28, 0x1050, "DS", "40");
  el(ds, 0x28, 0x1051, "DS", "400");
  el(ds, 0x28, 0x1052, "DS", "0");
  el(ds, 0x28, 0x1053, "DS", "1");
  const pix = new Uint8Array(px.buffer);
  const pdHead = [0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57, 0, 0, pix.length & 0xff, (pix.length >> 8) & 0xff, (pix.length >> 16) & 0xff, pix.length >>> 24];
  const out = new Uint8Array(132 + gl.length + meta.length + ds.length + pdHead.length + pix.length);
  out.set([0x44, 0x49, 0x43, 0x4d], 128);
  let o = 132;
  for (const part of [gl, meta, ds, pdHead]) {
    out.set(part, o);
    o += part.length;
  }
  out.set(pix, o);
  writeFileSync(`${dir}/IM${String(z + 1).padStart(5, "0")}.dcm`, out);
  bytes += out.length;
}
const result = { dir, slices: n, size, phantom: PHANTOM, files: n, bytes, studyUid };
writeFileSync(done, JSON.stringify(result));
console.log(JSON.stringify(result));
