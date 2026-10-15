// A multi-GB synthetic CT for the Share size checks: `n` slices of size² 16-bit pixels, one Part 10
// file each (explicit VR little endian), written to <dir>. Fictional patient, generated UIDs.
//   bun web/checks/share-big.ts <dir> [slices=1600] [size=1024]
// Prints JSON: { dir, files, bytes, studyUid }. Reuses the files if <dir>/done.json matches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uid } from "./synthetic";

const [dir, nArg, sizeArg] = process.argv.slice(2);
const n = Number(nArg ?? 1600), size = Number(sizeArg ?? 1024);
const done = `${dir}/done.json`;
if (existsSync(done)) {
  const d = JSON.parse(readFileSync(done, "utf8"));
  if (d.slices === n && d.size === size) {
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

const studyUid = uid(), seriesUid = uid();
const CT = "1.2.840.10008.5.1.4.1.1.2";
// One phantom, varied per slice by a moving disc, so slices differ but generation stays fast.
const base = new Int16Array(size * size).fill(-1000);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const u = (x - size / 2) / size, v = (y - size / 2) / size;
    if ((u / 0.42) ** 2 + (v / 0.32) ** 2 < 1) base[y * size + x] = 40 + ((x * 7 + y * 13) % 17) - 8;
    if (((u - 0.17) / 0.18) ** 2 + (v / 0.23) ** 2 < 1 || ((u + 0.17) / 0.18) ** 2 + (v / 0.23) ** 2 < 1) base[y * size + x] = -820;
  }
let bytes = 0;
for (let z = 0; z < n; z++) {
  const px = base.slice();
  const cx = Math.round(size / 2 + (size / 6) * Math.sin((2 * Math.PI * z) / n)), r = size / 20;
  for (let y = Math.max(0, cx - r); y < Math.min(size, cx + r); y++)
    for (let x = Math.max(0, size / 2 - r); x < Math.min(size, size / 2 + r); x++) if ((x - size / 2) ** 2 + (y - cx) ** 2 < r * r) px[y * size + x] = 900;
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
const result = { dir, slices: n, size, files: n, bytes, studyUid };
writeFileSync(done, JSON.stringify(result));
console.log(JSON.stringify(result));
