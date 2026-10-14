// Prints the test vector in PROPOSAL.md appendix B and checks round trips, ranges and tampering.
// Run: bun reference/test-vector.ts

import {
  b64urlDecode,
  b64urlEncode,
  ciphertextLength,
  ciphertextRange,
  decryptRange,
  deriveSeriesKey,
  encryptSeries,
  RECORD_CIPHERTEXT,
} from "./series-file.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

const shlKey = b64urlDecode("rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q"); // the key in the SHL spec's example
const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
// Two "instances" of 70,000 and 80,000 bytes; byte k of the series is k mod 251.
const lengths = [70000, 80000];
const total = lengths.reduce((a, b) => a + b, 0);
const plaintext = Uint8Array.from({ length: total }, (_, k) => k % 251);

const { rawKey, nonce } = await deriveSeriesKey(shlKey, salt);
const ct = await encryptSeries(plaintext, shlKey, salt);

console.log("SHL key (base64url):  ", b64urlEncode(shlKey));
console.log("series salt (hex):    ", hex(salt));
console.log("series salt (base64): ", btoa(String.fromCharCode(...salt)));
console.log("derived key (hex):    ", hex(rawKey));
console.log("base nonce (hex):     ", hex(nonce));
console.log("plaintext length:     ", total, "(instances", lengths.join(" + ") + ")");
console.log("ciphertext length:    ", ct.length);
console.log("plaintext sha256:     ", await sha256(plaintext));
console.log("ciphertext sha256:    ", await sha256(ct));
for (let i = 0; i * RECORD_CIPHERTEXT < ct.length; i++) {
  const rec = ct.subarray(i * RECORD_CIPHERTEXT, Math.min(ct.length, (i + 1) * RECORD_CIPHERTEXT));
  console.log(`record ${i}: ${rec.length} bytes, tag ${hex(rec.subarray(rec.length - 16))}`);
}
console.log();

check(ct.length === ciphertextLength(total), "ciphertext length is computable from plaintext length");

const whole = await decryptRange(ct, 0, total, total, shlKey, salt);
check(hex(whole) === hex(plaintext), "whole-file round trip");

// Instance 2 is plaintext bytes [70000, 150000).
const r = ciphertextRange(70000, 150000, total);
console.log(`instance 2 -> records ${r.first}..${r.last}, ciphertext bytes ${r.from}-${r.to - 1}`);
const inst2 = await decryptRange(ct.subarray(r.from, r.to), 70000, 150000, total, shlKey, salt);
check(hex(inst2) === hex(plaintext.subarray(70000)), "range read of instance 2");

const flipped = ct.slice();
flipped[70000] ^= 1;
await decryptRange(flipped, 0, total, total, shlKey, salt).then(
  () => check(false, "tampered byte rejected"),
  () => check(true, "tampered byte rejected"),
);

const swapped = new Uint8Array(ct.length);
swapped.set(ct.subarray(RECORD_CIPHERTEXT, 2 * RECORD_CIPHERTEXT), 0);
swapped.set(ct.subarray(0, RECORD_CIPHERTEXT), RECORD_CIPHERTEXT);
swapped.set(ct.subarray(2 * RECORD_CIPHERTEXT), 2 * RECORD_CIPHERTEXT);
await decryptRange(swapped, 0, total, total, shlKey, salt).then(
  () => check(false, "reordered records rejected"),
  () => check(true, "reordered records rejected"),
);

await decryptRange(ct.subarray(0, ct.length - RECORD_CIPHERTEXT), 0, total, total, shlKey, salt).then(
  () => check(false, "truncated file rejected"),
  () => check(true, "truncated file rejected"),
);

const otherSalt = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
await decryptRange(await encryptSeries(plaintext, shlKey, otherSalt), 0, total, total, shlKey, salt).then(
  () => check(false, "file encrypted under another salt rejected"),
  () => check(true, "file encrypted under another salt rejected"),
);
