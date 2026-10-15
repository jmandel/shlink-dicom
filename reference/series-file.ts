// Reference implementation of the series-file encryption in PROPOSAL.md §9.
// WebCrypto (AES-GCM) only; runs in Bun, Deno, Node 20+ and browsers.

export const RECORD_PLAINTEXT = 65520; // bytes of plaintext per full record
export const TAG = 16;
export const RECORD_CIPHERTEXT = RECORD_PLAINTEXT + TAG; // 65536

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importSeriesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) throw new Error("series key must be 32 bytes");
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Nonce for record i: i as a 12-byte (96-bit) big-endian unsigned integer. */
export function recordNonce(i: number): Uint8Array {
  const n = new Uint8Array(12);
  let x = BigInt(i);
  for (let k = 11; k >= 0 && x > 0n; k--) {
    n[k] = Number(x & 0xffn);
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

export async function encryptSeries(plaintext: Uint8Array, seriesKey: Uint8Array): Promise<Uint8Array> {
  const key = await importSeriesKey(seriesKey);
  const n = recordCount(plaintext.length);
  const out = new Uint8Array(ciphertextLength(plaintext.length));
  for (let i = 0; i < n; i++) {
    const chunk = plaintext.subarray(i * RECORD_PLAINTEXT, Math.min(plaintext.length, (i + 1) * RECORD_PLAINTEXT));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, chunk));
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
  seriesKey: Uint8Array,
): Promise<Uint8Array> {
  const r = ciphertextRange(start, end, plaintextLength);
  if (ciphertext.length !== r.to - r.from) throw new Error(`expected ${r.to - r.from} ciphertext bytes, got ${ciphertext.length}`);
  const key = await importSeriesKey(seriesKey);
  const parts: Uint8Array[] = [];
  for (let i = r.first; i <= r.last; i++) {
    const off = (i - r.first) * RECORD_CIPHERTEXT;
    const rec = ciphertext.subarray(off, Math.min(ciphertext.length, off + RECORD_CIPHERTEXT));
    parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, rec)));
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (joined.set(p, o), (o += p.length));
  const skip = start - r.first * RECORD_PLAINTEXT;
  return joined.subarray(skip, skip + (end - start));
}
