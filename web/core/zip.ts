// Streaming ZIP writer (store, no compression: DICOM pixel data is usually compressed already, and
// the files must stay byte-identical). Entries are written as they arrive; ZIP64 records are added
// when offsets pass 4 GiB.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Where ZIP bytes go: a file on disk, a Blob in memory, or anything else that accepts chunks. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

const MAX32 = 0xffffffff;

export class ZipWriter {
  private offset = 0;
  private entries: CentralEntry[] = [];
  /** Bytes written so far. */
  get bytesWritten() {
    return this.offset;
  }

  constructor(private sink: ByteSink) {}

  private async put(b: Uint8Array) {
    await this.sink.write(b);
    this.offset += b.byteLength;
  }

  /** Adds one stored file. */
  async add(path: string, data: Uint8Array) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const zip64 = data.byteLength >= MAX32 || this.offset >= MAX32;
    const extra = zip64 ? 20 : 0;
    const h = new Uint8Array(30 + name.length + extra);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, zip64 ? 45 : 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, 0x21, true); // 1980-01-01
    v.setUint32(14, crc, true);
    v.setUint32(18, zip64 ? MAX32 : data.byteLength, true);
    v.setUint32(22, zip64 ? MAX32 : data.byteLength, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, extra, true);
    h.set(name, 30);
    if (zip64) {
      v.setUint16(30 + name.length, 0x0001, true);
      v.setUint16(32 + name.length, 16, true);
      v.setBigUint64(34 + name.length, BigInt(data.byteLength), true);
      v.setBigUint64(42 + name.length, BigInt(data.byteLength), true);
    }
    this.entries.push({ name, crc, size: data.byteLength, offset: this.offset });
    await this.put(h);
    await this.put(data);
  }

  /** Writes the central directory and closes the sink. */
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const needs64 = e.size >= MAX32 || e.offset >= MAX32;
      const extra = needs64 ? 28 : 0;
      const c = new Uint8Array(46 + e.name.length + extra);
      const v = new DataView(c.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 45, true);
      v.setUint16(6, needs64 ? 45 : 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, 0, true);
      v.setUint16(14, 0x21, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, needs64 ? MAX32 : e.size, true);
      v.setUint32(24, needs64 ? MAX32 : e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extra, true);
      v.setUint32(42, needs64 ? MAX32 : e.offset, true);
      c.set(e.name, 46);
      if (needs64) {
        const o = 46 + e.name.length;
        v.setUint16(o, 0x0001, true);
        v.setUint16(o + 2, 24, true);
        v.setBigUint64(o + 4, BigInt(e.size), true);
        v.setBigUint64(o + 12, BigInt(e.size), true);
        v.setBigUint64(o + 20, BigInt(e.offset), true);
      }
      await this.put(c);
    }
    const cdSize = this.offset - cdStart;
    const n = this.entries.length;
    if (cdStart >= MAX32 || n >= 0xffff) {
      const z = new Uint8Array(56 + 20);
      const v = new DataView(z.buffer);
      const eocd64At = this.offset;
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setBigUint64(24, BigInt(n), true);
      v.setBigUint64(32, BigInt(n), true);
      v.setBigUint64(40, BigInt(cdSize), true);
      v.setBigUint64(48, BigInt(cdStart), true);
      v.setUint32(56, 0x07064b50, true);
      v.setBigUint64(64, BigInt(eocd64At), true);
      v.setUint32(72, 1, true);
      await this.put(z);
    }
    const e = new Uint8Array(22);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Math.min(n, 0xffff), true);
    v.setUint16(10, Math.min(n, 0xffff), true);
    v.setUint32(12, Math.min(cdSize, MAX32), true);
    v.setUint32(16, Math.min(cdStart, MAX32), true);
    await this.put(e);
    await this.sink.close();
  }
}
