// Pure-JS store-mode (uncompressed) ZIP builder + browser download triggers
// so multi-series / full-study exports stream instance-by-instance without exhausting WASM memory.

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

export function buildStoreZip(entries: ZipEntryInput[]): Blob {
  const te = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = te.encode(entry.path);
    const data = entry.data;
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, 0x04034b50, true); // signature
    lfhView.setUint16(4, 20, true); // version needed
    lfhView.setUint16(6, 0, true); // flags
    lfhView.setUint16(8, 0, true); // compression: 0 (store)
    lfhView.setUint16(10, 0, true); // mod time
    lfhView.setUint16(12, 0x5421, true); // mod date
    lfhView.setUint32(14, crc, true);
    lfhView.setUint32(18, data.byteLength, true);
    lfhView.setUint32(22, data.byteLength, true);
    lfhView.setUint16(26, nameBytes.length, true);
    lfhView.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    // Central directory header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdhView = new DataView(cdh.buffer);
    cdhView.setUint32(0, 0x02014b50, true);
    cdhView.setUint16(4, 20, true);
    cdhView.setUint16(6, 20, true);
    cdhView.setUint16(8, 0, true);
    cdhView.setUint16(10, 0, true);
    cdhView.setUint16(12, 0, true);
    cdhView.setUint16(14, 0x5421, true);
    cdhView.setUint32(16, crc, true);
    cdhView.setUint32(20, data.byteLength, true);
    cdhView.setUint32(24, data.byteLength, true);
    cdhView.setUint16(28, nameBytes.length, true);
    cdhView.setUint16(30, 0, true);
    cdhView.setUint16(32, 0, true);
    cdhView.setUint16(34, 0, true);
    cdhView.setUint16(36, 0, true);
    cdhView.setUint32(38, 0, true);
    cdhView.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    parts.push(lfh, data);
    centralDir.push(cdh);
    offset += lfh.byteLength + data.byteLength;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    cdSize += cd.byteLength;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdStart, true);
  eocdView.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
