// Raw DEFLATE with a limit on the output (JWE zip: DEF, deflated DICOM data sets): read in chunks
// and stopped as soon as it passes `max`, so a small input can't expand into gigabytes.

/** The most a DEFLATE stream is allowed to expand to here (64 MiB). */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export class InflateLimitError extends Error {
  constructor(max: number) {
    super(`the compressed data expands past ${max} bytes`);
    this.name = "InflateLimitError";
  }
}

/**
 * Inflates `data`. With `lenient`, an error after some output (padding after the end of the stream,
 * common in DICOM) ends the output there; otherwise it is thrown. Throws InflateLimitError past `max`.
 */
export async function inflateRawCapped(data: Uint8Array, max = MAX_INFLATED_BYTES, lenient = false): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        await reader.cancel().catch(() => {});
        throw new InflateLimitError(max);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof InflateLimitError || !lenient || !n) throw e;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
