// Prints the test vector in PROPOSAL.md appendix B, checks round trips, ranges and tampering,
// and writes the F0 golden share fixtures to fixtures/golden/.
// Run: bun reference/test-vector.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  b64urlDecode,
  b64urlEncode,
  ciphertextLength,
  ciphertextRange,
  decryptRange,
  encryptSeries,
  RECORD_CIPHERTEXT,
} from "./series-file.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

const te = new TextEncoder();
const td = new TextDecoder();

/** Encrypt a FHIR Bundle JSON string as a compact SHL JWE (alg:dir, enc:A256GCM, zip:DEF). */
async function encryptBundleJwe(bundleJson: string, shlKey: Uint8Array, fixedIv?: Uint8Array): Promise<string> {
  const headerB64 = b64urlEncode(te.encode(JSON.stringify({ alg: "dir", enc: "A256GCM", zip: "DEF" })));
  const iv = fixedIv ?? crypto.getRandomValues(new Uint8Array(12));
  const compressed = new Uint8Array(deflateRawSync(te.encode(bundleJson)));
  const key = await crypto.subtle.importKey("raw", shlKey, "AES-GCM", false, ["encrypt"]);
  const aad = te.encode(headerB64);
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, compressed),
  );
  const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
  const tag = ctWithTag.subarray(ctWithTag.length - 16);
  return `${headerB64}..${b64urlEncode(iv)}.${b64urlEncode(ct)}.${b64urlEncode(tag)}`;
}

/** Decrypt a compact SHL JWE (alg:dir, enc:A256GCM, zip?:DEF). */
async function decryptBundleJwe(jwe: string, shlKey: Uint8Array): Promise<string> {
  const parts = jwe.split(".");
  if (parts.length !== 5 || parts[1] !== "") throw new Error("invalid compact JWE");
  const [headerB64, , ivB64, ctB64, tagB64] = parts;
  const header = JSON.parse(td.decode(b64urlDecode(headerB64)));
  if (header.alg !== "dir" || header.enc !== "A256GCM") throw new Error("unsupported JWE alg/enc");
  const iv = b64urlDecode(ivB64);
  const ct = b64urlDecode(ctB64);
  const tag = b64urlDecode(tagB64);
  const ctWithTag = new Uint8Array(ct.length + tag.length);
  ctWithTag.set(ct, 0);
  ctWithTag.set(tag, ct.length);
  const key = await crypto.subtle.importKey("raw", shlKey, "AES-GCM", false, ["decrypt"]);
  const plainBytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(headerB64) }, key, ctWithTag),
  );
  const inflated = header.zip === "DEF" ? new Uint8Array(inflateRawSync(plainBytes)) : plainBytes;
  return td.decode(inflated);
}

const seriesKey = b64urlDecode("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"); // 32 bytes: 0x20..0x3f
const fileIdB64 = "AAECAwQFBgcICQoLDA0ODw";
// Two "instances" of 70,000 and 80,000 bytes; byte k of the series is k mod 251.
const lengths = [70000, 80000];
const total = lengths.reduce((a, b) => a + b, 0);
const plaintext = Uint8Array.from({ length: total }, (_, k) => k % 251);

const ct = await encryptSeries(plaintext, seriesKey);
const ptSha256 = await sha256(plaintext);
const ctSha256 = await sha256(ct);
const recordTags: string[] = [];

console.log("series key (base64url):", b64urlEncode(seriesKey));
console.log("series key (hex):      ", hex(seriesKey));
console.log("plaintext length:      ", total, "(instances", lengths.join(" + ") + ")");
console.log("ciphertext length:     ", ct.length);
console.log("plaintext sha256:      ", ptSha256);
console.log("ciphertext sha256:     ", ctSha256);
for (let i = 0; i * RECORD_CIPHERTEXT < ct.length; i++) {
  const rec = ct.subarray(i * RECORD_CIPHERTEXT, Math.min(ct.length, (i + 1) * RECORD_CIPHERTEXT));
  const tagHex = hex(rec.subarray(rec.length - 16));
  recordTags.push(tagHex);
  console.log(`record ${i}: ${rec.length} bytes, tag ${tagHex}`);
}
console.log();

check(ct.length === ciphertextLength(total), "ciphertext length is computable from plaintext length");

const whole = await decryptRange(ct, 0, total, total, seriesKey);
check(hex(whole) === hex(plaintext), "whole-file round trip");

// Instance 2 is plaintext bytes [70000, 150000).
const r = ciphertextRange(70000, 150000, total);
console.log(`instance 2 -> records ${r.first}..${r.last}, ciphertext bytes ${r.from}-${r.to - 1}`);
const inst2 = await decryptRange(ct.subarray(r.from, r.to), 70000, 150000, total, seriesKey);
check(hex(inst2) === hex(plaintext.subarray(70000)), "range read of instance 2");

const flipped = ct.slice();
flipped[70000] ^= 1;
await decryptRange(flipped, 0, total, total, seriesKey).then(
  () => check(false, "tampered byte rejected"),
  () => check(true, "tampered byte rejected"),
);

const swapped = new Uint8Array(ct.length);
swapped.set(ct.subarray(RECORD_CIPHERTEXT, 2 * RECORD_CIPHERTEXT), 0);
swapped.set(ct.subarray(0, RECORD_CIPHERTEXT), RECORD_CIPHERTEXT);
swapped.set(ct.subarray(2 * RECORD_CIPHERTEXT), 2 * RECORD_CIPHERTEXT);
await decryptRange(swapped, 0, total, total, seriesKey).then(
  () => check(false, "reordered records rejected"),
  () => check(true, "reordered records rejected"),
);

await decryptRange(ct.subarray(0, ct.length - RECORD_CIPHERTEXT), 0, total, total, seriesKey).then(
  () => check(false, "truncated file rejected"),
  () => check(true, "truncated file rejected"),
);

const otherKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
await decryptRange(await encryptSeries(plaintext, otherKey), 0, total, total, seriesKey).then(
  () => check(false, "file encrypted under another key rejected"),
  () => check(true, "file encrypted under another key rejected"),
);

// Build Appendix A golden Bundle and encrypt as JWE for F0 golden share fixtures.
const goldenBundle = {
  resourceType: "Bundle",
  meta: { lastUpdated: "2026-09-30T15:00:00Z" },
  type: "collection",
  entry: [
    {
      fullUrl: "urn:uuid:7b1d0f7e-3c9e-4b0a-9a51-0d8a4f0c2e11",
      resource: {
        resourceType: "Patient",
        id: "p1",
        name: [{ family: "Okafor", given: ["Linda"] }],
        birthDate: "1965-03-02",
      },
    },
    {
      fullUrl: "urn:uuid:9a4e2c71-5b3d-4e8f-b0a2-6c7d8e9f0a13",
      resource: {
        resourceType: "ImagingStudy",
        id: "ct1",
        meta: { profile: ["https://example.org/shl-dicom/v1"] },
        status: "available",
        identifier: [{ system: "urn:dicom:uid", value: "urn:oid:1.2.840.113619.2.55.3.604688119" }],
        subject: { reference: "Patient/p1" },
        started: "2026-09-30T14:12:00-05:00",
        numberOfSeries: 1,
        numberOfInstances: 2,
        series: [
          {
            extension: [
              {
                url: "https://example.org/shl-dicom/series-file",
                extension: [
                  { url: "id", valueString: fileIdB64 },
                  { url: "key", valueString: b64urlEncode(seriesKey) },
                ],
              },
            ],
            uid: "1.2.840.113619.2.55.3.604688119.971",
            number: 2,
            modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: "CT" },
            description: "Abdomen 5mm",
            numberOfInstances: 2,
            instance: [
              {
                extension: [{ url: "https://example.org/shl-dicom/length", valueDecimal: 70000 }],
                uid: "1.2.840.113619.2.55.3.604688119.971.1",
                sopClass: { system: "urn:ietf:rfc:3986", code: "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
                number: 1,
              },
              {
                extension: [{ url: "https://example.org/shl-dicom/length", valueDecimal: 80000 }],
                uid: "1.2.840.113619.2.55.3.604688119.971.2",
                sopClass: { system: "urn:ietf:rfc:3986", code: "urn:oid:1.2.840.10008.5.1.4.1.1.2" },
                number: 2,
              },
            ],
          },
        ],
      },
    },
    {
      fullUrl: "urn:uuid:c3d4e5f6-0718-4a29-b3c4-d5e6f7a8b9c0",
      resource: {
        resourceType: "DiagnosticReport",
        id: "r1",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "18748-4", display: "Diagnostic imaging study" }] },
        subject: { reference: "Patient/p1" },
        imagingStudy: [{ reference: "ImagingStudy/ct1" }],
        conclusion: "No acute abnormality.",
      },
    },
  ],
};

const shlKey = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const shlKeyB64 = b64urlEncode(shlKey); // canonical 43-char base64url for bytes 0x40..0x5f
const fixedJweIv = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
const bundleJsonStr = JSON.stringify(goldenBundle);
const bundleJwe = await encryptBundleJwe(bundleJsonStr, shlKey, fixedJweIv);
const decryptedBundleStr = await decryptBundleJwe(bundleJwe, shlKey);
check(decryptedBundleStr === bundleJsonStr, "golden Bundle JWE round trip");

mkdirSync("fixtures/golden", { recursive: true });
writeFileSync("fixtures/golden/bundle.jwe", bundleJwe);
writeFileSync(`fixtures/golden/${fileIdB64}.bin`, ct);
writeFileSync(
  "fixtures/golden/vector.json",
  JSON.stringify(
    {
      shlKey: shlKeyB64,
      fileId: fileIdB64,
      seriesKey: b64urlEncode(seriesKey),
      seriesKeyHex: hex(seriesKey),
      instanceLengths: lengths,
      plaintextLength: total,
      ciphertextLength: ct.length,
      plaintextSha256: ptSha256,
      ciphertextSha256: ctSha256,
      recordTags,
      instance2Range: r,
    },
    null,
    2,
  ),
);
console.log("ok: wrote F0 golden share fixtures to fixtures/golden/");
