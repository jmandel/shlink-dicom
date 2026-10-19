// Keep only the small, top-level attributes needed by DICOMDIR while an original streams past.
// A large private element or functional-groups sequence must not turn metadata collection into
// a whole-header allocation. The original bytes written to the archive are never changed.
import { readDicomHeader, type DicomHeader } from "./dicom-header";
import { LONG_VR } from "./dicom";
import { TS } from "./transfer-syntax";

const WANTED = new Set([
  0x00020002, 0x00020003, 0x00020010,
  0x00080005, 0x00080016, 0x00080018, 0x00080020, 0x00080030, 0x00080050,
  0x00080060, 0x00080090, 0x00081030, 0x0008103e,
  0x00100010, 0x00100020, 0x00100021, 0x00100030, 0x00100040,
  0x0020000d, 0x0020000e, 0x00200010, 0x00200011, 0x00200013,
]);
const join = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
};

export class DicomdirHeader {
  private tail = new Uint8Array();
  private parts: Uint8Array[] = [];
  private preamble = true;
  private meta = true;
  private syntax: string = TS.ImplicitLE;
  private skip = 0;
  private depth = 0;
  private done = false;
  private invalid = false;
  private inflater?: WritableStreamDefaultWriter<Uint8Array>;
  private inflated?: Promise<void>;

  /** At most one input chunk, a short incomplete attribute, and the selected values are held. */
  async feed(chunk: Uint8Array): Promise<void> {
    if (this.done) return;
    try {
      if (this.inflater) await this.inflater.write(chunk);
      else {
        const deflated = this.consume(chunk);
        if (deflated) {
          const stream = new DecompressionStream("deflate-raw");
          this.inflater = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          this.inflated = (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                this.consume(value);
                if (this.done) { await reader.cancel(); break; }
              }
            } catch { if (!this.done) this.invalid = this.done = true; }
          })();
          await this.inflater.write(deflated);
        }
      }
    } catch { if (!this.done) this.invalid = this.done = true; }
  }

  /** Returns the compressed dataset remainder when the File Meta Information ends. */
  private consume(chunk: Uint8Array): Uint8Array | undefined {
    const bytes = this.tail.length ? join(this.tail, chunk) : chunk;
    this.tail = new Uint8Array();
    let p = 0;
    if (this.preamble) {
      if (bytes.length < 132) { this.tail = bytes.slice(); return; }
      if (String.fromCharCode(...bytes.subarray(128, 132)) !== "DICM") { this.invalid = this.done = true; return; }
      this.parts.push(bytes.slice(0, 132)); this.preamble = false; p = 132;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (p < bytes.length && !this.done) {
      if (this.skip) {
        const n = Math.min(this.skip, bytes.length - p); p += n; this.skip -= n;
        if (p === bytes.length) return;
      }
      if (bytes.length - p < 8) break;
      if (this.meta && dv.getUint16(p, true) !== 2) {
        this.meta = false;
        if (this.syntax === TS.Deflated) return bytes.subarray(p);
      }
      const le = this.meta || this.syntax !== TS.ExplicitBE;
      const explicit = this.meta || this.syntax !== TS.ImplicitLE;
      const group = dv.getUint16(p, le), tag = (group * 65536 + dv.getUint16(p + 2, le)) >>> 0;
      if (!this.depth && (tag === 0x7fe00010 || tag === 0x7fe00008 || tag === 0x7fe00009)) { this.done = true; return; }
      const vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
      const long = group !== 0xfffe && explicit && LONG_VR.has(vr);
      const header = long ? 12 : 8;
      if (bytes.length - p < header) break;
      const length = group === 0xfffe || !explicit || long ? dv.getUint32(p + header - 4, le) : dv.getUint16(p + 6, le);
      if (tag === 0xfffee00d || tag === 0xfffee0dd) {
        if (!this.depth || length) throw new Error("invalid DICOM delimiter");
        this.depth--; p += header; continue;
      }
      if (length === 0xffffffff) { this.depth++; p += header; continue; }
      if (!this.depth && WANTED.has(tag)) {
        // All selected attributes have short DICOM value lengths. Refuse malformed sizes.
        if (length > 65536) throw new Error("oversized DICOMDIR attribute");
        if (bytes.length - p < header + length) break;
        let element = bytes.slice(p, p + header + length);
        if (tag === 0x00020010) {
          this.syntax = new TextDecoder().decode(bytes.subarray(p + header, p + header + length)).replace(/[\0 ]+$/, "");
          if (this.syntax === TS.Deflated) {
            // The compact metadata below contains the inflated attributes, not deflated bytes.
            const value = new TextEncoder().encode(TS.ExplicitLE + "\0");
            element = new Uint8Array(8 + value.length);
            element.set([2, 0, 16, 0, 85, 73, value.length, 0]); element.set(value, 8);
          }
        }
        this.parts.push(element); p += header + length;
      } else { p += header; this.skip = length; }
    }
    if (!this.done) this.tail = bytes.slice(p);
  }

  async finish(): Promise<DicomHeader | null> {
    if (this.inflater && !this.done) {
      try { await this.inflater.close(); } catch { this.invalid = true; }
    }
    await this.inflated;
    if (this.invalid || this.preamble || this.tail.length || this.skip || this.depth) return null;
    const length = this.parts.reduce((n, p) => n + p.length, 0), bytes = new Uint8Array(length);
    let at = 0;
    for (const p of this.parts) { bytes.set(p, at); at += p.length; }
    try { return { ...await readDicomHeader(bytes), transferSyntax: this.syntax }; } catch { return null; }
  }

  async dispose(): Promise<void> {
    try { await this.inflater?.abort(); } catch {}
    await this.inflated;
  }
}
