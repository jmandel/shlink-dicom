// Rewrites selected DICOM header attributes and remaps instance UIDs.
//
// Every element that is not changed, and every sequence item with no
// changed element inside it, is copied from the original file byte for
// byte. Pixel Data is never decoded or re-encoded: its whole element
// (header, value or encapsulated fragments, delimiter) is copied verbatim.
// Only changed elements and the containers and group lengths around them
// are re-encoded.

import { parseDicom, str, type DicomElement } from "../../src/dicom.ts";

export interface HeaderSet {
  vr: string;
  value: string; // multiple values joined with "\\"
}

export interface RewriteOptions {
  set: Map<number, HeaderSet>; // top-level attributes to set (inserted if absent)
  remove: Set<number>; // top-level attributes to drop
  removeGroups?: Set<number>; // top-level groups to drop entirely (e.g. private groups)
  replaceStrings?: Map<string, string>; // exact string values replaced at any depth
  mapUid: (uid: string) => string; // applied to the instance-identifying UID attributes below
  fillBasicOffsetTable?: boolean; // fill an empty Basic Offset Table in multi-frame encapsulated Pixel Data
}

// ---- Encapsulated Pixel Data ----

export interface PixelItem { start: number; valueStart: number; end: number; } // absolute offsets in the file

export interface Encapsulated {
  headerEnd: number; // just past the Pixel Data element header
  bot: PixelItem; // the Basic Offset Table item
  fragments: PixelItem[];
  delimiterStart: number;
}

export function readEncapsulated(src: Uint8Array, e: DicomElement): Encapsulated {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let pos = e.start + 12; // tag, VR, reserved, length (explicit VR) ...
  if (dv.getUint32(e.start + 4, true) === 0xffffffff) pos = e.start + 8; // ... or implicit VR
  const headerEnd = pos;
  const items: PixelItem[] = [];
  while (pos + 8 <= e.end) {
    const tag = ((dv.getUint16(pos, true) << 16) | dv.getUint16(pos + 2, true)) >>> 0;
    const len = dv.getUint32(pos + 4, true);
    if (tag === 0xfffee0dd) return { headerEnd, bot: items[0], fragments: items.slice(1), delimiterStart: pos };
    if (tag !== 0xfffee000) throw new Error(`unexpected tag ${tag.toString(16)} in encapsulated Pixel Data`);
    items.push({ start: pos, valueStart: pos + 8, end: pos + 8 + len });
    pos += 8 + len;
  }
  throw new Error("encapsulated Pixel Data has no sequence delimiter");
}

// Index of the first fragment of each frame. One fragment per frame when
// the counts match; otherwise a JPEG-family frame starts at a fragment
// that begins with an SOI marker (FF D8).
export function frameStarts(src: Uint8Array, enc: Encapsulated, frames: number): number[] {
  if (enc.fragments.length === frames) return enc.fragments.map((_, i) => i);
  const starts = enc.fragments.flatMap((f, i) => (src[f.valueStart] === 0xff && src[f.valueStart + 1] === 0xd8 ? [i] : []));
  if (starts.length !== frames || starts[0] !== 0) throw new Error(`cannot map ${enc.fragments.length} fragments to ${frames} frames`);
  return starts;
}

// Pixel Data element with a filled Basic Offset Table, or null to leave
// it as it is (native data, a single frame, or a table already present).
function withBasicOffsetTable(src: Uint8Array, e: DicomElement, frames: number): Uint8Array | null {
  if (!e.undefinedLength || frames < 2) return null;
  const enc = readEncapsulated(src, e);
  if (enc.bot.end > enc.bot.valueStart) return null;
  const firstItem = enc.fragments[0].start;
  const offsets = frameStarts(src, enc, frames).map((i) => enc.fragments[i].start - firstItem);
  if (offsets[offsets.length - 1] > 0xffffffff) throw new Error("offsets exceed 32 bits");
  const table = new Uint8Array(4 * frames);
  const tv = new DataView(table.buffer);
  offsets.forEach((o, i) => tv.setUint32(4 * i, o, true));
  return concat([
    src.subarray(e.start, enc.headerEnd),
    tagBytes(0xfffee000), u32(table.byteLength), table,
    src.subarray(firstItem, e.end), // fragments and the delimiter, verbatim
  ]);
}

// UID attributes that identify this data (and so are remapped). Coding
// scheme UIDs, SOP Class UIDs, transfer syntaxes and implementation or
// creator UIDs are left alone.
export const INSTANCE_UID_TAGS = new Set([
  0x00080017, // Acquisition UID
  0x00080018, // SOP Instance UID
  0x00080019, // Pyramid UID
  0x00081155, // Referenced SOP Instance UID
  0x0020000d, // Study Instance UID
  0x0020000e, // Series Instance UID
  0x00200052, // Frame of Reference UID
  0x00200200, // Synchronization Frame of Reference UID
  0x00209164, // Dimension Organization UID
  0x0040a124, // UID (content item)
  0x00400554, // Specimen UID
]);
const STRING_VRS = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UT"]);

const EXPLICIT_LONG = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const REGISTRY = "1.2.840.10008.";
const enc = new TextEncoder();

function u16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function tagBytes(tag: number) { return concat([u16(tag >>> 16), u16(tag & 0xffff)]); }

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function padded(vr: string, value: string): Uint8Array {
  if (/[^\x20-\x7e]/.test(value)) throw new Error(`non-ASCII value for ${vr}: ${value}`);
  const b = enc.encode(value);
  if (b.byteLength % 2 === 0) return b;
  return concat([b, new Uint8Array([vr === "UI" ? 0 : 0x20])]);
}

function header(tag: number, vr: string, len: number, explicit: boolean): Uint8Array {
  if (!explicit) return concat([tagBytes(tag), u32(len)]);
  if (EXPLICIT_LONG.has(vr)) return concat([tagBytes(tag), enc.encode(vr), new Uint8Array(2), u32(len)]);
  if (len > 0xffff) throw new Error(`value too long for ${vr}`);
  return concat([tagBytes(tag), enc.encode(vr), u16(len)]);
}

function element(tag: number, vr: string, value: Uint8Array, explicit: boolean): Uint8Array {
  return concat([header(tag, vr, value.byteLength, explicit), value]);
}

interface Out { tag: number; bytes: Uint8Array; dirty: boolean; }

function encodeLevel(src: Uint8Array, els: DicomElement[], explicit: boolean, top: boolean, o: RewriteOptions): { bytes: Uint8Array; dirty: boolean } {
  const out: Out[] = [];
  const seen = new Set<number>();
  for (const e of els) {
    seen.add(e.tag);
    if (top && (o.remove.has(e.tag) || o.removeGroups?.has(e.tag >>> 16))) continue;
    if (top && o.set.has(e.tag)) {
      const s = o.set.get(e.tag)!;
      out.push({ tag: e.tag, bytes: element(e.tag, s.vr, padded(s.vr, s.value), explicit), dirty: true });
      continue;
    }
    if (o.replaceStrings && STRING_VRS.has(e.vr) && !e.items) {
      const v = str([e], e.tag);
      const r = v !== undefined ? o.replaceStrings.get(v) : undefined;
      if (r !== undefined) { out.push({ tag: e.tag, bytes: element(e.tag, e.vr, padded(e.vr, r), explicit), dirty: true }); continue; }
    }
    if (e.vr === "UI" && !e.items && INSTANCE_UID_TAGS.has(e.tag)) {
      const v = str([e], e.tag);
      if (v && !v.startsWith(REGISTRY)) {
        const m = v.split("\\").map((u) => (u.startsWith(REGISTRY) ? u : o.mapUid(u))).join("\\");
        if (m !== v) { out.push({ tag: e.tag, bytes: element(e.tag, "UI", padded("UI", m), explicit), dirty: true }); continue; }
      }
    }
    if (top && o.fillBasicOffsetTable && e.tag === 0x7fe00010) {
      const frames = Number(str(els, 0x00280008) ?? "1");
      if (els.some((x) => x.tag === 0x7fe00001)) throw new Error("Extended Offset Table present; not adding a Basic Offset Table");
      const filled = withBasicOffsetTable(src, e, frames);
      if (filled) { out.push({ tag: e.tag, bytes: filled, dirty: true }); continue; }
    }
    if (e.items) {
      const itemExplicit = explicit && !e.fromUN;
      const items = e.items.map((it) => encodeLevel(src, it, itemExplicit, false, o));
      if (items.some((i) => i.dirty)) {
        if (e.fromUN) throw new Error("cannot re-encode a sequence read from UN");
        const parts: Uint8Array[] = [];
        items.forEach((it, i) => {
          const span = e.itemSpans![i];
          if (!it.dirty) { parts.push(src.subarray(span.start, span.end)); return; }
          if (span.undefinedLength) parts.push(concat([tagBytes(0xfffee000), u32(0xffffffff), it.bytes, tagBytes(0xfffee00d), u32(0)]));
          else parts.push(concat([tagBytes(0xfffee000), u32(it.bytes.byteLength), it.bytes]));
        });
        const body = concat(parts);
        const bytes = e.undefinedLength
          ? concat([header(e.tag, "SQ", 0xffffffff, explicit), body, tagBytes(0xfffee0dd), u32(0)])
          : concat([header(e.tag, "SQ", body.byteLength, explicit), body]);
        out.push({ tag: e.tag, bytes, dirty: true });
        continue;
      }
    }
    out.push({ tag: e.tag, bytes: src.subarray(e.start, e.end), dirty: false });
  }
  if (top) {
    for (const [tag, s] of o.set) {
      if (!seen.has(tag)) out.push({ tag, bytes: element(tag, s.vr, padded(s.vr, s.value), explicit), dirty: true });
    }
    out.sort((a, b) => a.tag - b.tag);
  }
  // Recompute group lengths for groups that changed.
  for (const g of out.filter((x) => (x.tag & 0xffff) === 0)) {
    const group = g.tag >>> 16;
    const members = out.filter((x) => x.tag >>> 16 === group && x !== g);
    if (members.some((m) => m.dirty)) {
      g.bytes = element(g.tag, "UL", u32(members.reduce((a, m) => a + m.bytes.byteLength, 0)), explicit);
      g.dirty = true;
    }
  }
  return { bytes: concat(out.map((x) => x.bytes)), dirty: out.some((x) => x.dirty) || out.length !== els.length };
}

export function rewriteDicom(src: Uint8Array, o: RewriteOptions): Uint8Array {
  const parsed = parseDicom(src, { stopAtPixelData: false });
  const explicit = parsed.transferSyntaxUID !== "1.2.840.10008.1.2";
  // File meta: only (0002,0003) Media Storage SOP Instance UID changes;
  // the group length is recomputed.
  const sop = str(parsed.meta, 0x00020003)!;
  const metaOpts: RewriteOptions = { set: new Map([[0x00020003, { vr: "UI", value: o.mapUid(sop) }]]), remove: new Set(), mapUid: (u) => u };
  const meta = encodeLevel(src, parsed.meta, true, true, metaOpts);
  const dataset = encodeLevel(src, parsed.dataset, explicit, true, o);
  return concat([src.subarray(0, 132), meta.bytes, dataset.bytes]);
}

// Bytes of the whole Pixel Data element (tag through end), for comparison.
export function pixelDataElement(bytes: Uint8Array): Uint8Array {
  const p = parseDicom(bytes, { stopAtPixelData: false });
  const e = p.dataset.find((x) => x.tag === 0x7fe00010);
  if (!e) throw new Error("no Pixel Data element");
  return bytes.subarray(e.start, e.end);
}

// Deterministic UID under the 2.25 root (ITU-T X.667): a name-based UUID
// (version 5 layout over SHA-256) of namespace + original UID, as a decimal.
export function mintUid(namespace: string, original: string): string {
  const h = new Uint8Array(new Bun.CryptoHasher("sha256").update(`${namespace}:${original}`).digest());
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return `2.25.${n.toString()}`;
}

function pixelElement(bytes: Uint8Array) {
  const p = parseDicom(bytes, { stopAtPixelData: false });
  const e = p.dataset.find((x) => x.tag === 0x7fe00010);
  if (!e) throw new Error("no Pixel Data element");
  return { e, frames: Number(str(p.dataset, 0x00280008) ?? "1") };
}

// The Basic Offset Table entries, or [] when the table is empty.
export function basicOffsets(bytes: Uint8Array): number[] {
  const { e } = pixelElement(bytes);
  const enc = readEncapsulated(bytes, e);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + enc.bot.valueStart, enc.bot.end - enc.bot.valueStart);
  return Array.from({ length: dv.byteLength / 4 }, (_, i) => dv.getUint32(4 * i, true));
}

// True when the BOT has one entry per frame, each pointing exactly at the
// item tag of that frame's first fragment (offsets counted from the first
// fragment's item tag).
export function basicOffsetTableValid(bytes: Uint8Array): boolean {
  const { e, frames } = pixelElement(bytes);
  const enc = readEncapsulated(bytes, e);
  const offsets = basicOffsets(bytes);
  const first = enc.fragments[0].start;
  const expected = frameStarts(bytes, enc, frames).map((i) => enc.fragments[i].start - first);
  return offsets.length === frames && offsets.every((o, i) => o === expected[i]);
}

// Frame data unchanged: either the whole Pixel Data element is identical,
// or both are encapsulated with identical fragment items (headers and
// bytes, in order) and the only change is a Basic Offset Table filled
// where the source had an empty one.
export function samePixelFrames(before: Uint8Array, after: Uint8Array): boolean {
  if (Buffer.compare(before, after) === 0) return true;
  const hasPixels = (b: Uint8Array) => parseDicom(b, { stopAtPixelData: false }).dataset.some((e) => e.tag === 0x7fe00010);
  if (!hasPixels(before) && !hasPixels(after)) return true;
  if (Buffer.compare(pixelDataElement(before), pixelDataElement(after)) === 0) return true;
  const a = pixelElement(before), b = pixelElement(after);
  if (!a.e.undefinedLength || !b.e.undefinedLength) return false;
  const ea = readEncapsulated(before, a.e), eb = readEncapsulated(after, b.e);
  if (ea.bot.end !== ea.bot.valueStart) return false; // the source table was not empty
  if (ea.fragments.length !== eb.fragments.length) return false;
  const fa = before.subarray(ea.fragments[0].start, ea.delimiterStart);
  const fb = after.subarray(eb.fragments[0].start, eb.delimiterStart);
  return Buffer.compare(fa, fb) === 0 && basicOffsetTableValid(after);
}
