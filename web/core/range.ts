// Series-file record arithmetic (PROPOSAL.md §9.2–9.3) and range planning.
import type { SeriesEntry } from "./bundle";

/** Plaintext bytes per record. */
export const RECORD_PLAINTEXT = 65_520;
/** AES-GCM tag bytes per record. */
export const TAG = 16;
/** Ciphertext bytes per full record. */
export const RECORD_CIPHERTEXT = RECORD_PLAINTEXT + TAG;

export function recordCount(plaintextLength: number): number {
  return plaintextLength === 0 ? 1 : Math.ceil(plaintextLength / RECORD_PLAINTEXT);
}

export function ciphertextLength(plaintextLength: number): number {
  return plaintextLength + recordCount(plaintextLength) * TAG;
}

/** One HTTP Range read covering plaintext [plaintextStart, plaintextEnd) of a series file. */
export interface RangePlan {
  fileId: string;
  /** Instances fully covered, inclusive (both -1 for a raw byte plan). */
  firstInstance: number;
  lastInstance: number;
  plaintextStart: number;
  plaintextEnd: number;
  firstRecord: number;
  lastRecord: number;
  /** Ciphertext byte range [start, end) to request. */
  ciphertextStart: number;
  ciphertextEnd: number;
  /** "bytes=a-b" */
  rangeHeader: string;
}

/** Plans the read of plaintext bytes [a, b) of a series (§9.3). */
export function planBytes(series: SeriesEntry, a: number, b: number): RangePlan {
  if (!(a >= 0 && a < b && b <= series.plaintextLength)) {
    throw new RangeError(`bad plaintext range [${a}, ${b}) of ${series.plaintextLength}`);
  }
  const firstRecord = Math.floor(a / RECORD_PLAINTEXT);
  const lastRecord = Math.floor((b - 1) / RECORD_PLAINTEXT);
  const ciphertextStart = firstRecord * RECORD_CIPHERTEXT;
  const ciphertextEnd = Math.min(series.ciphertextLength, (lastRecord + 1) * RECORD_CIPHERTEXT);
  return {
    fileId: series.fileId,
    firstInstance: -1,
    lastInstance: -1,
    plaintextStart: a,
    plaintextEnd: b,
    firstRecord,
    lastRecord,
    ciphertextStart,
    ciphertextEnd,
    rangeHeader: `bytes=${ciphertextStart}-${ciphertextEnd - 1}`,
  };
}

/** Plans the read of instances first..last (inclusive) of a series. */
export function planInstances(series: SeriesEntry, first: number, last = first): RangePlan {
  const i0 = series.instances[first];
  const i1 = series.instances[last];
  if (!i0 || !i1 || last < first) throw new RangeError(`bad instance range ${first}..${last}`);
  return { ...planBytes(series, i0.offset, i1.offset + i1.length), firstInstance: first, lastInstance: last };
}

/** Plans the whole series file. */
export function planSeries(series: SeriesEntry): RangePlan {
  return planInstances(series, 0, series.instances.length - 1);
}

/**
 * Splits a series into consecutive runs of instances of at most `maxBytes` plaintext each
 * (at least one instance per run), for whole-series downloads that stream run by run.
 */
export function planRuns(series: SeriesEntry, maxBytes = 8 * 1024 * 1024): RangePlan[] {
  const out: RangePlan[] = [];
  let start = 0;
  let bytes = 0;
  series.instances.forEach((inst, i) => {
    if (i > start && bytes + inst.length > maxBytes) {
      out.push(planInstances(series, start, i - 1));
      start = i;
      bytes = 0;
    }
    bytes += inst.length;
  });
  if (series.instances.length) out.push(planInstances(series, start, series.instances.length - 1));
  return out;
}

/** The 12-byte AES-GCM nonce of record i: uint96 big-endian. */
export function recordNonce(i: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(8, i >>> 0);
  new DataView(n.buffer).setUint32(4, Math.floor(i / 2 ** 32));
  return n;
}
