// Reference implementation of the series-file encryption in PROPOSAL.md §9.
// WebCrypto only; runs in Bun, Deno, Node 20+ and browsers.

export const RECORD_PLAINTEXT = 65520; // bytes of plaintext per full record
export const TAG = 16;
export const RECORD_CIPHERTEXT = RECORD_PLAINTEXT + TAG; // 65536

const te = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HKDF-SHA-256 (RFC 5869) from the SHL key and the series salt. */
export async function deriveSeriesKey(shlKey: Uint8Array, salt: Uint8Array): Promise<{ key: CryptoKey; nonce: Uint8Array; rawKey: Uint8Array }> {
  if (shlKey.length !== 32) throw new Error("SHL key must be 32 bytes");
  if (salt.length !== 16) throw new Error("series salt must be 16 bytes");
  const ikm = await crypto.subtle.importKey("raw", shlKey, "HKDF", false, ["deriveBits"]);
  const bits = (info: string, len: number) =>
    crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, ikm, len * 8);
  const rawKey = new Uint8Array(await bits("shl-dicom-v1 key", 32));
  const nonce = new Uint8Array(await bits("shl-dicom-v1 nonce", 12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, nonce, rawKey };
}

/** Nonce for record i: the base nonce XOR i as a 96-bit big-endian integer. */
export function recordNonce(base: Uint8Array, i: number): Uint8Array {
  const n = base.slice();
  let x = BigInt(i);
  for (let k = 11; k >= 0 && x > 0n; k--) {
    n[k] ^= Number(x & 0xffn);
    x >>= 8n;
  }
  return n;
}

export function recordCount(plaintextLength: number): number {
  return Math.max(1, Math.ceil(plaintextLength / RECORD_PLAINTEXT));
}

export function ciphertextLength(plaintextLength: number): number {
  return plaintextLength + recordCount(plaintextLength) * TAG;
}

export async function encryptSeries(plaintext: Uint8Array, shlKey: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const { key, nonce } = await deriveSeriesKey(shlKey, salt);
  const n = recordCount(plaintext.length);
  const out = new Uint8Array(ciphertextLength(plaintext.length));
  for (let i = 0; i < n; i++) {
    const chunk = plaintext.subarray(i * RECORD_PLAINTEXT, Math.min(plaintext.length, (i + 1) * RECORD_PLAINTEXT));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(nonce, i) }, key, chunk));
    out.set(ct, i * RECORD_CIPHERTEXT);
  }
  return out;
}

/** The ciphertext byte range holding plaintext bytes [start, end) of a series file. */
export function ciphertextRange(start: number, end: number, plaintextLength: number) {
  if (start < 0 || end > plaintextLength || start >= end) throw new Error("bad range");
  const first = Math.floor(start / RECORD_PLAINTEXT);
  const last = Math.floor((end - 1) / RECORD_PLAINTEXT);
  const from = first * RECORD_CIPHERTEXT;
  const to = Math.min(ciphertextLength(plaintextLength), (last + 1) * RECORD_CIPHERTEXT); // exclusive
  return { first, last, from, to };
}

/**
 * Decrypt plaintext bytes [start, end) given the ciphertext bytes that ciphertextRange() names.
 * Throws if any record fails authentication or the bytes are not exactly the expected length.
 */
export async function decryptRange(
  ciphertext: Uint8Array,
  start: number,
  end: number,
  plaintextLength: number,
  shlKey: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const r = ciphertextRange(start, end, plaintextLength);
  if (ciphertext.length !== r.to - r.from) throw new Error(`expected ${r.to - r.from} ciphertext bytes, got ${ciphertext.length}`);
  const { key, nonce } = await deriveSeriesKey(shlKey, salt);
  const parts: Uint8Array[] = [];
  for (let i = r.first; i <= r.last; i++) {
    const off = (i - r.first) * RECORD_CIPHERTEXT;
    const rec = ciphertext.subarray(off, Math.min(ciphertext.length, off + RECORD_CIPHERTEXT));
    parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: recordNonce(nonce, i) }, key, rec)));
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (joined.set(p, o), (o += p.length));
  const skip = start - r.first * RECORD_PLAINTEXT;
  return joined.subarray(skip, skip + (end - start));
}
