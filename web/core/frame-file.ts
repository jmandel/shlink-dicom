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
import { parseDicomSync, T, UNDEF } from "./dicom";
import type { SlideHeader } from "./wsi";

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
    if (header.byteLength < 132 || header[128] !== 0x44 || header[131] !== 0x4d) return null;
    let r;
    try {
      r = parseDicomSync(header, { untilPixelData: true });
    } catch {
      return null;
    }
    if (r.transferSyntax === "1.2.840.10008.1.2.1.99" || r.transferSyntax === "1.2.840.10008.1.2.2" || !r.meta.get(T.TransferSyntaxUID)) return null;
    const pre: Uint8Array[] = [header.subarray(0, r.metaEnd)];
    const post: Uint8Array[] = [];
    let perFrame: { head: Uint8Array; items: [number, number][]; undefined: boolean } | null = null;
    let frames = false;
    for (const el of r.ds.elements.values()) {
      const start = el.start!, end = el.offset + el.length;
      const out = perFrame ? post : pre;
      if (el.tag === T.NumberOfFrames) {
        // Number of Frames (IS): "1" padded to the value's length.
        const v = header.slice(start, end);
        const off = el.offset - start;
        v.fill(0x20, off);
        v[off] = 0x31;
        out.push(v);
        frames = true;
      } else if (el.tag === T.PerFrameFunctionalGroupsSequence) {
        const head = header.slice(start, el.offset);
        const undef = new DataView(head.buffer).getUint32(head.byteLength - 4, true) === UNDEF;
        perFrame = { head, items: r.ds.seq(el.tag).map((it) => [it.start, it.end] as [number, number]), undefined: undef };
      } else if (!DROP.has(el.tag)) {
        out.push(header.subarray(start, end));
      }
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
