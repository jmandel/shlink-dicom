// Range planning over the encrypted files (spec/README.md §9.3). The record grid itself (sizes,
// counts, nonces) is viewer-kit's record-decrypt.ts, re-exported here.
import type { SeriesEntry } from "./bundle";
import { RECORD_CIPHERTEXT, RECORD_PLAINTEXT } from "../../viewer-kit/src/record-decrypt";

export { ciphertextLength, RECORD_CIPHERTEXT, recordCiphertextLength, recordCount, recordNonce, RECORD_PLAINTEXT, TAG } from "../../viewer-kit/src/record-decrypt";

/** One HTTP Range read covering plaintext [plaintextStart, plaintextEnd) of a file. */
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

/** Plans the read of plaintext bytes [a, b) of the series' file (§9.3). */
export function planBytes(series: SeriesEntry, a: number, b: number): RangePlan {
  const file = series.file;
  if (!(a >= 0 && a < b && b <= file.plaintextLength)) {
    throw new RangeError(`bad plaintext range [${a}, ${b}) of ${file.plaintextLength}`);
  }
  const firstRecord = Math.floor(a / RECORD_PLAINTEXT);
  const lastRecord = Math.floor((b - 1) / RECORD_PLAINTEXT);
  const ciphertextStart = firstRecord * RECORD_CIPHERTEXT;
  const ciphertextEnd = Math.min(file.ciphertextLength, (lastRecord + 1) * RECORD_CIPHERTEXT);
  return {
    fileId: file.fileId,
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

/** Plans the read of instances first..last (inclusive) of a series: one range of its file. */
export function planInstances(series: SeriesEntry, first: number, last = first): RangePlan {
  const i0 = series.instances[first];
  const i1 = series.instances[last];
  if (!i0 || !i1 || last < first) throw new RangeError(`bad instance range ${first}..${last}`);
  return { ...planBytes(series, i0.offset, i1.offset + i1.length), firstInstance: first, lastInstance: last };
}

/** Plans the whole series: [series.offset, series.offset + series.bytes) of its file. */
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
