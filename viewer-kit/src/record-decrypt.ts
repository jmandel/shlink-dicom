// Series-file record decryption with WebCrypto (PROPOSAL.md §9).
//
// A series file is a run of AES-256-GCM records: every record but the last is 65,536 bytes
// (65,520 bytes of ciphertext followed by a 16-byte tag), and record i uses the nonce
// uint96_be(i). decryptRecords() verifies every record's tag, keeps a bounded number of
// crypto.subtle.decrypt calls in flight, and returns the plaintext in record order.
//
// Works in browsers (window and workers), Bun, Deno and Node 20+.

export const RECORD_PLAINTEXT = 65_520;
export const TAG = 16;
export const RECORD_CIPHERTEXT = RECORD_PLAINTEXT + TAG; // 65,536

/** Calls in flight per decryptRecords() call unless opts.concurrency says otherwise. */
const DEFAULT_CONCURRENCY = 8;

export interface DecryptRecordsOptions {
  /** Maximum crypto.subtle.decrypt calls in flight (default DEFAULT_CONCURRENCY). */
  concurrency?: number;
  /**
   * The series' total plaintext length (from the Bundle's instance lengths). When given, every
   * record's length is checked against §9: records before the last must be 65,536 bytes, the
   * series' final record must be its remainder plus 16, and the range must not run past the end.
   * Without it, only the tags are checked, so a range missing whole trailing records is not
   * detected: the caller must compare lengths itself, as PROPOSAL.md §9.3 says.
   */
  seriesPlaintextLength?: number;
  /**
   * Where to write the plaintext. Must be at least the plaintext length; the result is a view
   * of its first bytes. Use it to decrypt straight into a buffer the decoder already owns (for
   * example a region of a SharedArrayBuffer). Do not pass a view of WebAssembly memory that may
   * grow while the calls are in flight: growth detaches the view.
   */
  output?: Uint8Array;
  /**
   * Return only plaintext bytes [start, start + length) of the decrypted run, counted from the
   * start of the first record (for a read of series bytes [a, b): start = a − 65,520·first,
   * length = b − a, as in PROPOSAL.md §9.3). Every record is still verified. Each record's
   * plaintext is copied once, straight to its place in the result, so one instance can be
   * decrypted into an ArrayBuffer of exactly its size and transferred to a decoder worker.
   */
  window?: { start: number; length: number };
  /** Stops issuing calls and rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** A record failed authentication, or its length is wrong for its position in the series. */
export class RecordAuthenticationError extends Error {
  constructor(
    readonly recordIndex: number,
    readonly reason: string,
  ) {
    super(`series record ${recordIndex}: ${reason}`);
    this.name = "RecordAuthenticationError";
  }
}

/** Imports a 32-byte series key as a non-extractable AES-GCM key usable only to decrypt. */
export async function importSeriesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error(`series key must be 32 bytes, got ${raw.length}`);
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["decrypt"]);
}

/** Nonce for record i: i as a 12-byte big-endian unsigned integer (i up to 2^53 − 1). */
export function recordNonce(i: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(i) || i < 0) throw new RangeError(`bad record index ${i}`);
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(i / 2 ** 32));
  v.setUint32(8, i >>> 0);
  return n;
}

/** Plaintext length of a run of records whose ciphertext is `ciphertextLength` bytes. */
export function plaintextLengthOf(ciphertextLength: number): number {
  const n = Math.ceil(ciphertextLength / RECORD_CIPHERTEXT);
  const last = ciphertextLength - (n - 1) * RECORD_CIPHERTEXT;
  if (n === 0 || last < TAG) throw new RecordAuthenticationError(Math.max(0, n - 1), "shorter than a tag");
  return ciphertextLength - n * TAG;
}

/**
 * Decrypts and verifies the records in `ciphertext`, the first of which is record
 * `firstRecordIndex` of its series file. Resolves with the concatenated plaintext, in order.
 * Rejects with RecordAuthenticationError if any record fails; the output is zeroed then.
 *
 * `ciphertext` must not be backed by a SharedArrayBuffer (WebCrypto refuses those).
 */
export async function decryptRecords(
  key: CryptoKey,
  ciphertext: Uint8Array,
  firstRecordIndex: number,
  opts: DecryptRecordsOptions = {},
): Promise<Uint8Array> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const len = ciphertext.length;
  if (len === 0) throw new RecordAuthenticationError(firstRecordIndex, "no ciphertext");
  const count = Math.ceil(len / RECORD_CIPHERTEXT);
  const lastIndex = firstRecordIndex + count - 1;
  const lastLen = len - (count - 1) * RECORD_CIPHERTEXT;
  if (lastLen < TAG) throw new RecordAuthenticationError(lastIndex, `${lastLen} bytes is shorter than a tag`);

  if (opts.seriesPlaintextLength !== undefined) {
    const P = opts.seriesPlaintextLength;
    const total = Math.max(1, Math.ceil(P / RECORD_PLAINTEXT));
    if (lastIndex >= total) throw new RecordAuthenticationError(lastIndex, `series has only ${total} records`);
    if (lastIndex === total - 1) {
      const want = P - lastIndex * RECORD_PLAINTEXT + TAG;
      if (lastLen !== want) throw new RecordAuthenticationError(lastIndex, `final record is ${lastLen} bytes, expected ${want}`);
    } else if (lastLen !== RECORD_CIPHERTEXT) {
      throw new RecordAuthenticationError(lastIndex, `record is ${lastLen} bytes, expected ${RECORD_CIPHERTEXT}`);
    }
  }

  const fullLen = len - count * TAG;
  const winStart = opts.window?.start ?? 0;
  const ptLen = opts.window?.length ?? fullLen;
  if (!Number.isSafeInteger(winStart) || !Number.isSafeInteger(ptLen) || winStart < 0 || ptLen < 0 || winStart + ptLen > fullLen) {
    throw new RangeError(`window [${winStart}, ${winStart + ptLen}) is outside the ${fullLen} plaintext bytes`);
  }
  if (opts.output && opts.output.length < ptLen) throw new RangeError(`output holds ${opts.output.length} bytes, need ${ptLen}`);
  const out = opts.output ? opts.output.subarray(0, ptLen) : new Uint8Array(ptLen);
  const winEnd = winStart + ptLen;

  let next = 0;
  let failure: unknown = null;
  const lane = async () => {
    while (failure === null && next < count) {
      if (opts.signal?.aborted) {
        failure = opts.signal.reason ?? new DOMException("aborted", "AbortError");
        return;
      }
      const k = next++;
      const i = firstRecordIndex + k;
      const off = k * RECORD_CIPHERTEXT;
      const rec = ciphertext.subarray(off, Math.min(len, off + RECORD_CIPHERTEXT));
      try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, rec as Uint8Array<ArrayBuffer>);
        const at = k * RECORD_PLAINTEXT; // this record's plaintext offset in the run
        const lo = Math.max(winStart, at);
        const hi = Math.min(winEnd, at + pt.byteLength);
        if (lo < hi) out.set(new Uint8Array(pt, lo - at, hi - lo), lo - winStart);
      } catch (e) {
        if (failure === null) {
          failure =
            e instanceof DOMException && e.name === "OperationError"
              ? new RecordAuthenticationError(i, "tag does not verify")
              : e;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, lane));
  if (failure !== null) {
    out.fill(0); // never leave unauthenticated plaintext behind
    throw failure;
  }
  return out;
}
