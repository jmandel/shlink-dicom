// Record decryption (PROPOSAL.md §9.2–9.3) behind one interface, so the implementation can be
// swapped: WebCrypto (default) or the Rust session in shl_dicom_wasm (see decrypt-wasm.ts).
import { b64urlDecode } from "./b64";
import type { SeriesEntry } from "./bundle";
import { RECORD_CIPHERTEXT, RECORD_PLAINTEXT, TAG, recordNonce, type RangePlan } from "./range";

/** A record failed its AES-GCM check, or its length is wrong for its place in the series. */
export class RecordAuthenticationError extends Error {
  constructor(
    readonly fileId: string,
    readonly recordIndex: number,
    reason: string,
  ) {
    super(`record ${recordIndex} of ${fileId}.bin ${reason}`);
    this.name = "RecordAuthenticationError";
  }
}

export interface RecordDecryptor {
  readonly name: "webcrypto" | "wasm";
  /**
   * Verifies every record `plan` covers and returns plaintext [plan.plaintextStart, plan.plaintextEnd)
   * in a fresh ArrayBuffer of exactly that size (safe to transfer to a worker).
   * `ciphertext` is exactly bytes [plan.ciphertextStart, plan.ciphertextEnd) of the series file.
   * Throws RecordAuthenticationError; never returns bytes from a record that failed.
   */
  decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** Expected ciphertext length of record i of a series (§9.2). */
export function recordCiphertextLength(series: SeriesEntry, i: number): number {
  return i < series.recordCount - 1 ? RECORD_CIPHERTEXT : series.plaintextLength - i * RECORD_PLAINTEXT + TAG;
}

/** WebCrypto AES-256-GCM, one subtle.decrypt per record, all records of a plan in flight at once. */
export class WebCryptoDecryptor implements RecordDecryptor {
  readonly name = "webcrypto" as const;
  private keys = new Map<string, Promise<CryptoKey>>();

  private key(series: SeriesEntry): Promise<CryptoKey> {
    let k = this.keys.get(series.fileId);
    if (!k) {
      // Non-extractable and decrypt-only, as §10.2 recommends.
      k = crypto.subtle.importKey("raw", b64urlDecode(series.key), "AES-GCM", false, ["decrypt"]);
      this.keys.set(series.fileId, k);
    }
    return k;
  }

  async decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array> {
    const key = await this.key(series);
    const outLen = plan.plaintextEnd - plan.plaintextStart;
    const out = new Uint8Array(outLen);
    const windowStart = plan.plaintextStart;
    const jobs: Promise<void>[] = [];
    let off = 0;
    for (let i = plan.firstRecord; i <= plan.lastRecord; i++) {
      const len = recordCiphertextLength(series, i);
      if (off + len > ciphertext.byteLength) {
        throw new RecordAuthenticationError(series.fileId, i, "is truncated");
      }
      const rec = ciphertext.subarray(off, off + len);
      off += len;
      const recPlainStart = i * RECORD_PLAINTEXT;
      jobs.push(
        crypto.subtle
          .decrypt({ name: "AES-GCM", iv: recordNonce(i), tagLength: 128 }, key, rec as BufferSource)
          .then(
            (pt) => {
              const p = new Uint8Array(pt);
              // Copy the part of this record inside the requested window.
              const from = Math.max(0, windowStart - recPlainStart);
              const to = Math.min(p.length, plan.plaintextEnd - recPlainStart);
              if (to > from) out.set(p.subarray(from, to), recPlainStart + from - windowStart);
            },
            () => {
              throw new RecordAuthenticationError(series.fileId, i, "failed its integrity check");
            },
          ),
      );
    }
    if (off !== ciphertext.byteLength) {
      throw new RecordAuthenticationError(series.fileId, plan.lastRecord, "has extra bytes after it");
    }
    await Promise.all(jobs);
    return out;
  }
}

export type DecryptorKind = "webcrypto" | "wasm";

/**
 * Creates a decryptor. "wasm" loads shl_dicom_wasm (2.6 MB) on demand and needs the Bundle bytes;
 * it only decrypts instance-aligned plans.
 */
export async function createDecryptor(kind: DecryptorKind, bundleBytes?: Uint8Array): Promise<RecordDecryptor> {
  if (kind === "wasm") {
    const { WasmSessionDecryptor } = await import("./decrypt-wasm");
    if (!bundleBytes) throw new Error("the wasm decryptor needs the Bundle");
    return WasmSessionDecryptor.create(bundleBytes);
  }
  return new WebCryptoDecryptor();
}
