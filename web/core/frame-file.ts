// One-frame Part 10 files for the decoder, made from an instance's own header: a frame of a
// multi-frame image (frames.ts) or a tile of a slide (wsi-source.ts).
//
//   const ff = FrameFiles.of(header, pixelElement, h);   // once per instance; null: can't be made
//   const file = ff.file(k, frameBytes, bitShift);       // frame k: decode as any instance
//
// The header keeps every attribute the decoder reads (pixel module, rescale, windows, LUTs,
// functional groups), with Number of Frames 1, only frame k's item of the Per-Frame Functional
// Groups Sequence, and no Extended Offset Table. ICC profiles (the top-level one and those in the
// Optical Path Sequence) are left out: the decoder does not read them, and on a slide they are
// most of a tile's header.
import type { SlideHeader } from "./wsi";

const UNDEF = 0xffffffff;
const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const ITEM = new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]);
const SEQ_END = new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);

/** Top-level elements left out of a one-frame file's header. */
const DROP = new Set([
  0x7fe00001, // Extended Offset Table: it describes every frame
  0x7fe00002, // Extended Offset Table Lengths
  0x00282000, // ICC Profile
  0x00480105, // Optical Path Sequence (ICC profiles, descriptions)
]);

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.byteLength;
  }
  return out;
}

export class FrameFiles {
  private constructor(
    /** Header bytes before the Per-Frame Functional Groups (or all of them when there are none). */
    private pre: Uint8Array,
    /** The Per-Frame Functional Groups element header, its items, and whether it is undefined-length. */
    private perFrame: { head: Uint8Array; items: [number, number][]; undefined: boolean } | null,
    /** Header bytes after it. */
    private post: Uint8Array,
    private header: Uint8Array,
    private pixelElement: Uint8Array,
    readonly h: SlideHeader,
  ) {}

  /**
   * The layout of an instance's header (`header`: its bytes before Pixel Data; `pixelElement`:
   * the Pixel Data element's own header). Null for a header this cannot rewrite (big endian,
   * deflated, no Number of Frames) or one that does not parse.
   */
  static of(header: Uint8Array, pixelElement: Uint8Array, h: SlideHeader): FrameFiles | null {
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const n = header.byteLength;
    if (n < 132 || dv.getUint32(128) !== 0x4449434d) return null;
    let p = 132;
    let ts = "";
    while (p + 8 <= n && dv.getUint16(p, true) === 0x0002) {
      const vr = String.fromCharCode(header[p + 4], header[p + 5]);
      const long = LONG_VR.has(vr);
      const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
      const vo = p + (long ? 12 : 8);
      if (dv.getUint16(p + 2, true) === 0x0010) ts = String.fromCharCode(...header.subarray(vo, vo + len)).replace(/[\0 ]+$/, "");
      p = vo + len;
    }
    if (ts === "1.2.840.10008.1.2.1.99" || ts === "1.2.840.10008.1.2.2" || !ts) return null;
    const explicit = ts !== "1.2.840.10008.1.2";

    const readEl = (q: number) => {
      if (q + 8 > n) return null;
      const tag = ((dv.getUint16(q, true) << 16) | dv.getUint16(q + 2, true)) >>> 0;
      let len: number, vo: number;
      const vr = String.fromCharCode(header[q + 4], header[q + 5]);
      if (tag >>> 16 !== 0xfffe && explicit && /^[A-Z]{2}$/.test(vr)) {
        if (LONG_VR.has(vr)) {
          if (q + 12 > n) return null;
          len = dv.getUint32(q + 8, true);
          vo = q + 12;
        } else {
          len = dv.getUint16(q + 6, true);
          vo = q + 8;
        }
      } else {
        len = dv.getUint32(q + 4, true);
        vo = q + 8;
      }
      const end = len === UNDEF ? skipUndefined(vo) : vo + len;
      return end < 0 || end > n ? null : { tag, start: q, vo, len, end };
    };
    /** Position after the delimiter closing an undefined-length value at q, or -1. */
    const skipUndefined = (q: number): number => {
      while (q + 8 <= n) {
        if (dv.getUint16(q, true) === 0xfffe) {
          const e = dv.getUint16(q + 2, true), len = dv.getUint32(q + 4, true);
          if (e === 0xe0dd || e === 0xe00d) return q + 8;
          const end = len === UNDEF ? skipUndefined(q + 8) : q + 8 + len;
          if (end < 0) return -1;
          q = end;
          continue;
        }
        const el = readEl(q);
        if (!el) return -1;
        q = el.end;
      }
      return -1;
    };

    const pre: Uint8Array[] = [header.subarray(0, p)];
    const post: Uint8Array[] = [];
    let perFrame: { head: Uint8Array; items: [number, number][]; undefined: boolean } | null = null;
    let frames = false;
    while (p < n) {
      const el = readEl(p);
      if (!el) return null;
      const out = perFrame ? post : pre;
      if (el.tag === 0x00280008) {
        // Number of Frames (IS): "1" padded to the value's length.
        const v = header.slice(el.start, el.end);
        const off = el.vo - el.start;
        v.fill(0x20, off);
        v[off] = 0x31;
        out.push(v);
        frames = true;
      } else if (el.tag === 0x52009230) {
        const items: [number, number][] = [];
        let q = el.vo;
        const stop = el.len === UNDEF ? el.end - 8 : el.end;
        while (q < stop) {
          if (dv.getUint16(q, true) !== 0xfffe || dv.getUint16(q + 2, true) !== 0xe000) return null;
          const len = dv.getUint32(q + 4, true);
          const end = len === UNDEF ? skipUndefined(q + 8) : q + 8 + len;
          if (end < 0 || end > stop) return null;
          items.push([q, end]);
          q = end;
        }
        perFrame = { head: header.slice(el.start, el.vo), items, undefined: el.len === UNDEF };
      } else if (!DROP.has(el.tag)) {
        out.push(header.subarray(el.start, el.end));
      }
      p = el.end;
    }
    if (!frames) return null;
    return new FrameFiles(concatBytes(pre), perFrame, concatBytes(post), header, pixelElement, h);
  }

  /**
   * The one-frame file of frame k: the header, then Pixel Data holding `frame` (the frame's
   * fragment items, or its native bytes; a 1-bit frame starting at bit `bitShift`). Null when the
   * Per-Frame Functional Groups have no item k.
   */
  file(k: number, frame: Uint8Array, bitShift = 0): Uint8Array<ArrayBuffer> | null {
    const parts: Uint8Array[] = [this.pre];
    const pf = this.perFrame;
    if (pf) {
      const item = pf.items[k];
      if (!item) return null;
      const head = pf.head.slice();
      new DataView(head.buffer).setUint32(head.byteLength - 4, pf.undefined ? UNDEF : item[1] - item[0], true);
      parts.push(head, this.header.subarray(item[0], item[1]));
      if (pf.undefined) parts.push(SEQ_END);
    }
    parts.push(this.post);
    const h = this.h;
    const el = this.pixelElement.slice();
    const ev = new DataView(el.buffer);
    const lenAt = el.byteLength - 4;
    if (h.encapsulated) {
      ev.setUint32(lenAt, UNDEF, true);
      // The frame's bytes are items: keep whole items only.
      const fv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      let used = 0;
      while (used + 8 <= frame.byteLength && fv.getUint16(used, true) === 0xfffe && fv.getUint16(used + 2, true) === 0xe000) {
        const len = fv.getUint32(used + 4, true);
        if (len === UNDEF || used + 8 + len > frame.byteLength) break;
        used += 8 + len;
      }
      parts.push(el, ITEM, frame.subarray(0, used), SEQ_END);
      return concatBytes(parts);
    }
    let data = frame;
    if (h.bitsAllocated === 1) {
      // Frames of 1-bit data are packed back to back: re-align this one to its first byte.
      const out = new Uint8Array(Math.ceil((h.rows * h.columns * h.samplesPerPixel) / 8));
      for (let i = 0; i < out.length; i++) out[i] = ((frame[i] >> bitShift) | ((frame[i + 1] ?? 0) << (8 - bitShift))) & 0xff;
      data = out;
    }
    const pad = data.byteLength % 2 ? new Uint8Array(1) : new Uint8Array(0);
    ev.setUint32(lenAt, data.byteLength + pad.byteLength, true);
    parts.push(el, data, pad);
    return concatBytes(parts);
  }
}
