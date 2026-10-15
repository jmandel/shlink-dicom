// Random-access byte sources, so the Share page can work with files far larger than memory. An
// instance's bytes are read on demand from a File (or a slice of one), a staged copy in the
// origin-private file system, a series in a shared link, or a short in-memory head.

export interface Bytes {
  readonly size: number;
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array>;
}

export class BlobBytes implements Bytes {
  constructor(readonly blob: Blob) {}
  get size() {
    return this.blob.size;
  }
  async read(a: number, b: number) {
    return new Uint8Array(await this.blob.slice(a, b).arrayBuffer());
  }
}

export class MemBytes implements Bytes {
  constructor(readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  async read(a: number, b: number) {
    return this.bytes.subarray(a, b);
  }
}

/** A window [offset, offset + length) of another source. */
export class SubBytes implements Bytes {
  constructor(
    readonly base: Bytes,
    readonly offset: number,
    readonly size: number,
  ) {}
  read(a: number, b: number) {
    return this.base.read(this.offset + a, this.offset + Math.min(b, this.size));
  }
}

/** Sources laid end to end (an offset-table patch: new head + the original from some point). */
export class ConcatBytes implements Bytes {
  readonly size: number;
  private starts: number[] = [];
  constructor(readonly parts: Bytes[]) {
    let n = 0;
    for (const p of parts) {
      this.starts.push(n);
      n += p.size;
    }
    this.size = n;
  }
  async read(a: number, b: number) {
    b = Math.min(b, this.size);
    const out = new Uint8Array(Math.max(0, b - a));
    let o = 0;
    for (let i = 0; i < this.parts.length && a < b; i++) {
      const s = this.starts[i], e = s + this.parts[i].size;
      if (e <= a) continue;
      const chunk = await this.parts[i].read(a - s, Math.min(b, e) - s);
      out.set(chunk, o);
      o += chunk.length;
      a += chunk.length;
    }
    return out;
  }
}

/** Reads [a, b) of the concatenation of `parts` (a series' plaintext: its instances in order). */
export async function readAcross(parts: Bytes[], a: number, b: number): Promise<Uint8Array> {
  return new ConcatBytes(parts).read(a, b);
}

/**
 * Sequential reader with a window, for walking headers in a large source without many tiny reads.
 */
export class WindowReader {
  private start = 0;
  private buf = new Uint8Array(0);
  constructor(
    readonly src: Bytes,
    readonly window = 4 << 20,
  ) {}
  async get(a: number, n: number): Promise<Uint8Array | null> {
    if (a + n > this.src.size) return null;
    if (a < this.start || a + n > this.start + this.buf.length) {
      this.start = a;
      this.buf = await this.src.read(a, Math.min(this.src.size, a + Math.max(n, this.window)));
    }
    return this.buf.subarray(a - this.start, a - this.start + n);
  }
}
