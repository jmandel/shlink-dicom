// shl-dicom-wasm: the offset-table rewrite the Share page uses (crates/shl-dicom-wasm/src/lib.rs).
// Self-contained: builds a synthetic multi-frame file. Run: bun test test/wasm.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initSync, offset_table_patch_wasm } from "../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

initSync({ module: readFileSync(new URL("../crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm", import.meta.url)) });

const le16 = (n: number) => [n & 0xff, n >> 8];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];

/** A JPEG-baseline-syntax multi-frame file with an empty Basic Offset Table, frame k split into `split` fragments. */
function slide(frames: number, split = 1, soi = true): { file: Uint8Array; frames: Uint8Array[] } {
  const b: number[] = new Array(128).fill(0);
  b.push(...[0x44, 0x49, 0x43, 0x4d]);
  const el = (out: number[], g: number, e: number, vr: string, v: number[] | string) => {
    let val = typeof v === "string" ? Array.from(new TextEncoder().encode(v)) : v;
    if (val.length % 2) val = [...val, vr === "UI" ? 0 : 0x20];
    out.push(...le16(g), ...le16(e), vr.charCodeAt(0), vr.charCodeAt(1));
    if (vr === "OB") out.push(0, 0, ...le32(val.length));
    else out.push(...le16(val.length));
    out.push(...val);
  };
  const meta: number[] = [];
  el(meta, 0x0002, 0x0001, "OB", [0, 1]);
  el(meta, 0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.77.1.6");
  el(meta, 0x0002, 0x0003, "UI", "2.25.1");
  el(meta, 0x0002, 0x0010, "UI", "1.2.840.10008.1.2.4.50");
  el(b, 0x0002, 0x0000, "UL", le32(meta.length));
  b.push(...meta);
  el(b, 0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.77.1.6");
  el(b, 0x0008, 0x0018, "UI", "2.25.1");
  el(b, 0x0028, 0x0002, "US", le16(1));
  el(b, 0x0028, 0x0004, "CS", "MONOCHROME2");
  el(b, 0x0028, 0x0008, "IS", String(frames));
  el(b, 0x0028, 0x0010, "US", le16(8));
  el(b, 0x0028, 0x0011, "US", le16(8));
  el(b, 0x0028, 0x0100, "US", le16(8));
  el(b, 0x0028, 0x0101, "US", le16(8));
  el(b, 0x0028, 0x0102, "US", le16(7));
  el(b, 0x0028, 0x0103, "US", le16(0));
  b.push(0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0, 0, 0xff, 0xff, 0xff, 0xff);
  b.push(0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0); // empty Basic Offset Table
  const out: Uint8Array[] = [];
  for (let k = 0; k < frames; k++) {
    const whole: number[] = [];
    for (let f = 0; f < split; f++) {
      const v = f === 0 && soi ? [0xff, 0xd8] : [0x11, 0x22];
      for (let i = 0; i < 10 + 7 * k + 4 * f; i++) v.push((i * 31 + k) & 0xff);
      b.push(0xfe, 0xff, 0x00, 0xe0, ...le32(v.length), ...v);
      whole.push(...v);
    }
    out.push(new Uint8Array(whole));
  }
  b.push(0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0);
  return { file: new Uint8Array(b), frames: out };
}

/** Reads the Basic Offset Table and the fragments after it from a patched file. */
function readPixelData(file: Uint8Array) {
  const dv = new DataView(file.buffer, file.byteOffset);
  let p = file.length - 1;
  for (p = 132; p < file.length - 4; p++) if (dv.getUint32(p, true) === 0x00107fe0) break;
  p += 12;
  const botLen = dv.getUint32(p + 4, true);
  const bot = Array.from({ length: botLen / 4 }, (_, i) => dv.getUint32(p + 8 + 4 * i, true));
  p += 8 + botLen;
  const fragments: { at: number; bytes: Uint8Array }[] = [];
  const start = p;
  while (dv.getUint16(p + 2, true) === 0xe000) {
    const len = dv.getUint32(p + 4, true);
    fragments.push({ at: p - start, bytes: file.subarray(p + 8, p + 8 + len) });
    p += 8 + len;
  }
  return { bot, fragments };
}

const apply = (file: Uint8Array) => {
  const patch = offset_table_patch_wasm(file);
  if (!patch) return null;
  const head = patch.head;
  const out = new Uint8Array(head.length + file.length - patch.resume_at);
  out.set(head);
  out.set(file.subarray(patch.resume_at), head.length);
  const info = { frames: patch.frames, extended: patch.extended };
  patch.free();
  return { out, ...info };
};

test("fills an empty Basic Offset Table; fragment bytes unchanged", () => {
  const { file, frames } = slide(5);
  const r = apply(file)!;
  expect(r.frames).toBe(5);
  expect(r.extended).toBe(false);
  const { bot, fragments } = readPixelData(r.out);
  expect(bot.length).toBe(5);
  fragments.forEach((f, k) => {
    expect(bot[k]).toBe(f.at);
    expect(Array.from(f.bytes)).toEqual(Array.from(frames[k]));
  });
});

test("frames split over several fragments point at each frame's first fragment", () => {
  const { file } = slide(4, 3);
  const r = apply(file)!;
  const { bot, fragments } = readPixelData(r.out);
  expect(bot).toEqual([0, 3, 6, 9].map((i) => fragments[i].at));
});

test("leaves files that need no table, or whose frames are ambiguous", () => {
  expect(apply(slide(1).file)).toBeNull(); // one frame
  expect(apply(apply(slide(3).file)!.out)).toBeNull(); // already has a table
  expect(apply(slide(3, 2, false).file)).toBeNull(); // 6 fragments, no frame markers
});
