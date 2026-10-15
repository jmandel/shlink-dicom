// Verification against the corpus oracle (.npy). Runs in Node and in the browser.
// A benchmark record is only trusted when verify.ok is true.

/** Parse a NumPy .npy file (v1-v3, little-endian integer dtypes). */
export function parseNpy(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] !== 0x93 || String.fromCharCode(...u8.subarray(1, 6)) !== "NUMPY") throw new Error("not an .npy file");
  const major = u8[6];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hlen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hstart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(u8.subarray(hstart, hstart + hlen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran-order .npy not supported");
  return { descr, shape, data: u8.subarray(hstart + hlen) };
}

function typed(descr, u8) {
  // Copy to an aligned buffer so typed views are valid regardless of the source offset.
  const buf = u8.byteOffset % 8 === 0 ? u8 : u8.slice();
  const C = { "|u1": Uint8Array, "<u1": Uint8Array, "|i1": Int8Array, "<i1": Int8Array, "<u2": Uint16Array, "<i2": Int16Array, "<u4": Uint32Array, "<i4": Int32Array }[descr];
  if (!C) throw new Error(`unsupported dtype ${descr}`);
  return new C(buf.buffer, buf.byteOffset, buf.byteLength / C.BYTES_PER_ELEMENT);
}

/**
 * Compare decoded bytes with the oracle. Exact byte equality passes immediately; otherwise the
 * largest per-sample difference must be <= maxAbs (lossy syntaxes).
 */
export function verifyOutput(out, npyBytes, maxAbs) {
  const npy = parseNpy(npyBytes);
  if (out.byteLength !== npy.data.byteLength) {
    return { ok: false, exact: false, reason: `output ${out.byteLength} bytes, oracle ${npy.data.byteLength} (${npy.descr} [${npy.shape}])` };
  }
  let equal = true;
  const a = out, b = npy.data;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { equal = false; break; }
  if (equal) return { ok: true, exact: true, max_abs_diff: 0 };
  const x = typed(npy.descr, a), y = typed(npy.descr, b);
  let mx = 0, differing = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - y[i]);
    if (d) differing++;
    if (d > mx) mx = d;
  }
  const ok = mx <= maxAbs;
  return { ok, exact: false, max_abs_diff: mx, samples_differing: differing, ...(ok ? {} : { reason: `max |diff| ${mx} > allowed ${maxAbs}` }) };
}
