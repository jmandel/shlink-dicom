// Minimal reader for gzip-compressed ustar/GNU tar archives.
// Returns each regular file's path and exact bytes (a view into the
// decompressed archive; no copies, no re-encoding).

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

function cstr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(off, end));
}

function octal(buf: Uint8Array, off: number, len: number): number {
  const s = cstr(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

export function readTgz(gz: Uint8Array): TarEntry[] {
  const tar = Bun.gunzipSync(gz);
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const magic = cstr(header, 257, 6);
    let name = cstr(header, 0, 100);
    if (magic.startsWith("ustar")) {
      const prefix = cstr(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const text = new TextDecoder().decode(data);
      for (const line of text.split("\n")) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g") continue;
    const path = paxPath ?? longName ?? name;
    longName = null;
    paxPath = null;
    if (type === "0" || type === "\0") out.push({ path, bytes: data });
  }
  return out;
}
