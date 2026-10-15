// Where an instance's header ends: the byte offset of its top-level Pixel Data element
// ((7FE0,0010), or the float variants (7FE0,0008) and (7FE0,0009)), so a decode can also hand back
// the attributes before the pixels (overlays, LUTs, geometry) without copying the pixels.
// Returns the whole length when there is no pixel data or the data set is deflated.

const UNDEF = 0xffffffff;
const LONG = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);

export function headerEnd(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = b.length;
  if (n < 132 || dv.getUint32(128) !== 0x4449434d) return n;
  let p = 132;
  let ts = "";
  // File meta: explicit VR little endian.
  while (p + 8 <= n && dv.getUint16(p, true) === 0x0002) {
    const e = dv.getUint16(p + 2, true);
    const vr = String.fromCharCode(b[p + 4], b[p + 5]);
    const long = LONG.has(vr);
    const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
    const vo = p + (long ? 12 : 8);
    if (e === 0x0010) ts = String.fromCharCode(...b.subarray(vo, vo + len)).replace(/[\0 ]+$/, "");
    p = vo + len;
  }
  if (ts === "1.2.840.10008.1.2.1.99") return n;
  const explicit = ts !== "1.2.840.10008.1.2";
  const le = ts !== "1.2.840.10008.1.2.2";
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);

  const skipUndefined = (q: number, depth: number): number => {
    while (q + 8 <= n) {
      const g = u16(q), e = u16(q + 2);
      if (g === 0xfffe) {
        const len = u32(q + 4);
        if (e === 0xe0dd || e === 0xe00d) return q + 8;
        q = len === UNDEF ? skipUndefined(q + 8, depth + 1) : q + 8 + len;
        continue;
      }
      q = next(q, depth + 1);
    }
    return n;
  };
  const next = (q: number, depth: number): number => {
    if (depth > 64) return n;
    let len: number, vo: number;
    const vr = String.fromCharCode(b[q + 4], b[q + 5]);
    if (explicit && /^[A-Z]{2}$/.test(vr)) {
      if (LONG.has(vr)) {
        len = u32(q + 8);
        vo = q + 12;
      } else {
        len = u16(q + 6);
        vo = q + 8;
      }
    } else {
      len = u32(q + 4);
      vo = q + 8;
    }
    return len === UNDEF ? skipUndefined(vo, depth) : vo + len;
  };

  while (p + 8 <= n) {
    const g = u16(p), e = u16(p + 2);
    if (g === 0x7fe0 && (e === 0x0010 || e === 0x0008 || e === 0x0009)) return p;
    if (g > 0x7fe0) return n;
    p = next(p, 0);
  }
  return n;
}
