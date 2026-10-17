// Record decryption (spec/README.md §9.2–9.3) behind one interface. The implementations share
// viewer-kit's record-decrypt.ts (WebCrypto): WebCryptoDecryptor runs it on the calling thread;
// PoolDecryptor (images.ts) runs it in the decoder workers.
import { decryptRecords, importFileKey, RecordAuthenticationError } from "../../viewer-kit/src/record-decrypt";
import { b64urlDecode } from "./b64";
import type { SeriesEntry } from "./bundle";
import { RECORD_PLAINTEXT, type RangePlan } from "./range";

export { RecordAuthenticationError };

export interface RecordDecryptor {
  /**
   * Verifies every record `plan` covers and returns plaintext [plan.plaintextStart, plan.plaintextEnd)
   * in a fresh buffer of exactly that size. `ciphertext` is exactly bytes
   * [plan.ciphertextStart, plan.ciphertextEnd) of the series' file; it may be transferred (detached).
   * Throws RecordAuthenticationError; never returns bytes from a record that failed.
   */
  decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array>;
}

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * The key of the series' file as a non-extractable, decrypt-only CryptoKey, imported once per file
 * and key: two Bundles may name the same file id with different keys, and each gets its own.
 */
export function seriesKey(series: SeriesEntry): Promise<CryptoKey> {
  const { fileId, key } = series.file;
  const id = `${fileId}:${key}`;
  let k = keys.get(id);
  if (!k) {
    k = importFileKey(b64urlDecode(key));
    keys.set(id, k);
  }
  return k;
}

/** decryptRecords' arguments for a plan: which records, and which plaintext bytes to keep. */
export async function decryptParams(series: SeriesEntry, plan: RangePlan) {
  return {
    key: await seriesKey(series),
    firstRecord: plan.firstRecord,
    filePlaintextLength: series.file.plaintextLength,
    window: { start: plan.plaintextStart - plan.firstRecord * RECORD_PLAINTEXT, length: plan.plaintextEnd - plan.plaintextStart },
  };
}

/** Decrypts on the calling thread. */
export class WebCryptoDecryptor implements RecordDecryptor {
  async decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array> {
    const p = await decryptParams(series, plan);
    return decryptRecords(p.key, ciphertext, p.firstRecord, { window: p.window, filePlaintextLength: p.filePlaintextLength });
  }
}
