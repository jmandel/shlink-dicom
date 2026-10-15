// Prints the test vector in PROPOSAL.md appendix B, checks round trips, ranges and tampering,
// checks the §8.1 byte layout of the Appendix A Bundle (a study file plus a series-level file),
// and writes the golden share fixtures to fixtures/golden/.
// Run: bun reference/test-vector.ts

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  b64urlDecode,
  b64urlEncode,
  ciphertextLength,
  ciphertextRange,
  decryptRange,
  encryptFile,
  EXT_INSTANCE_LENGTH,
  EXT_LINKED_FILE,
  layout,
  PROFILE_URL,
  RECORD_CIPHERTEXT,
} from "./linked-file.ts";

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

const fileKey = b64urlDecode("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"); // 32 bytes: 0x20..0x3f
const fileIdB64 = "AAECAwQFBgcICQoLDA0ODw"; // bytes 0x00..0x0f
// The study file: two "instances" of 70,000 and 80,000 bytes; byte k of the file is k mod 251.
const lengths = [70000, 80000];
const total = lengths.reduce((a, b) => a + b, 0);
const plaintext = Uint8Array.from({ length: total }, (_, k) => k % 251);

const ct = await encryptFile(plaintext, fileKey);
const ptSha256 = await sha256(plaintext);
const ctSha256 = await sha256(ct);
const recordTags: string[] = [];

console.log("file key (base64url):  ", b64urlEncode(fileKey));
console.log("file key (hex):        ", hex(fileKey));
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

const whole = await decryptRange(ct, 0, total, total, fileKey);
check(hex(whole) === hex(plaintext), "whole-file round trip");

// Instance 2 is plaintext bytes [70000, 150000).
const r = ciphertextRange(70000, 150000, total);
console.log(`instance 2 -> records ${r.first}..${r.last}, ciphertext bytes ${r.from}-${r.to - 1}`);
const inst2 = await decryptRange(ct.subarray(r.from, r.to), 70000, 150000, total, fileKey);
check(hex(inst2) === hex(plaintext.subarray(70000)), "range read of instance 2");

const flipped = ct.slice();
flipped[70000] ^= 1;
await decryptRange(flipped, 0, total, total, fileKey).then(
  () => check(false, "tampered byte rejected"),
  () => check(true, "tampered byte rejected"),
);

const swapped = new Uint8Array(ct.length);
swapped.set(ct.subarray(RECORD_CIPHERTEXT, 2 * RECORD_CIPHERTEXT), 0);
swapped.set(ct.subarray(0, RECORD_CIPHERTEXT), RECORD_CIPHERTEXT);
swapped.set(ct.subarray(2 * RECORD_CIPHERTEXT), 2 * RECORD_CIPHERTEXT);
await decryptRange(swapped, 0, total, total, fileKey).then(
  () => check(false, "reordered records rejected"),
  () => check(true, "reordered records rejected"),
);

await decryptRange(ct.subarray(0, ct.length - RECORD_CIPHERTEXT), 0, total, total, fileKey).then(
  () => check(false, "truncated file rejected"),
  () => check(true, "truncated file rejected"),
);

const otherKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
await decryptRange(await encryptFile(plaintext, otherKey), 0, total, total, fileKey).then(
  () => check(false, "file encrypted under another key rejected"),
  () => check(true, "file encrypted under another key rejected"),
);

// The series-level file of Appendix A: a series added to the study later, in a file of its own.
// One 20,000-byte "instance"; byte k is k mod 241.
const addedFileId = b64urlEncode(Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i)); // bytes 0x10..0x1f
const addedKey = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i); // bytes 0x60..0x7f
const addedLength = 20000;
const addedPlaintext = Uint8Array.from({ length: addedLength }, (_, k) => k % 241);
const addedCt = await encryptFile(addedPlaintext, addedKey);
const addedTag = hex(addedCt.subarray(addedCt.length - 16));
console.log();
console.log("series-level file id:  ", addedFileId);
console.log("series-level file key: ", b64urlEncode(addedKey));
console.log("plaintext length:      ", addedLength);
console.log("ciphertext length:     ", addedCt.length);
console.log("plaintext sha256:      ", await sha256(addedPlaintext));
console.log("ciphertext sha256:     ", await sha256(addedCt));
console.log(`record 0: ${addedCt.length} bytes, tag ${addedTag}`);
console.log();

const linkedFile = (id: string, key: Uint8Array) => ({
  url: EXT_LINKED_FILE,
  extension: [
    { url: "id", valueString: id },
    { url: "key", valueString: b64urlEncode(key) },
  ],
});
const instance = (uid: string, sopClass: string, number: number, length: number) => ({
  extension: [{ url: EXT_INSTANCE_LENGTH, valueDecimal: length }],
  uid,
  sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${sopClass}` },
  number,
});
const CT_IMAGE = "1.2.840.10008.5.1.4.1.1.2";
const DOSE_SR = "1.2.840.10008.5.1.4.1.1.88.67";
const DCM = "http://dicom.nema.org/resources/ontology/DCM";

// Appendix A: the study file holds series 2 and 997; series 3 was added later in a file of its own.
const imagingStudy = {
  resourceType: "ImagingStudy",
  id: "ct1",
  meta: { profile: [PROFILE_URL] },
  extension: [linkedFile(fileIdB64, fileKey)],
  status: "available",
  identifier: [{ system: "urn:dicom:uid", value: "urn:oid:1.2.840.113619.2.55.3.604688119" }],
  subject: { reference: "Patient/p1" },
  started: "2026-09-30T14:12:00-05:00",
  numberOfSeries: 3,
  numberOfInstances: 3,
  series: [
    {
      uid: "1.2.840.113619.2.55.3.604688119.971",
      number: 2,
      modality: { system: DCM, code: "CT" },
      description: "Abdomen 5mm",
      numberOfInstances: 1,
      instance: [instance("1.2.840.113619.2.55.3.604688119.971.1", CT_IMAGE, 1, lengths[0])],
    },
    {
      uid: "1.2.840.113619.2.55.3.604688119.997",
      number: 997,
      modality: { system: DCM, code: "SR" },
      description: "Dose report",
      numberOfInstances: 1,
      instance: [instance("1.2.840.113619.2.55.3.604688119.997.1", DOSE_SR, 1, lengths[1])],
    },
    {
      extension: [linkedFile(addedFileId, addedKey)],
      uid: "1.2.840.113619.2.55.3.604688119.973",
      number: 3,
      modality: { system: DCM, code: "CT" },
      description: "Abdomen 5mm delayed",
      numberOfInstances: 1,
      instance: [instance("1.2.840.113619.2.55.3.604688119.973.1", CT_IMAGE, 1, addedLength)],
    },
  ],
};

// §8.1: series 2 and 997 resolve to the study's file, series 3 to its own; offsets run per file.
const lay = layout(imagingStudy);
const where = lay.instances.map((x) => `${x.fileId}@${x.offset}+${x.length}`).join(" ");
console.log("layout:", where);
check(
  where === `${fileIdB64}@0+70000 ${fileIdB64}@70000+80000 ${addedFileId}@0+20000`,
  "study-level default file, series-level override, offsets per file",
);
check(
  lay.files.map((f) => `${f.id}:${f.plaintextLength}`).join(" ") === `${fileIdB64}:${total} ${addedFileId}:${addedLength}`,
  "file plaintext lengths are the final offsets",
);
const filesById = new Map([
  [fileIdB64, { ct, key: fileKey, P: total }],
  [addedFileId, { ct: addedCt, key: addedKey, P: addedLength }],
]);
const expected = [plaintext.subarray(0, 70000), plaintext.subarray(70000), addedPlaintext];
for (const [k, loc] of lay.instances.entries()) {
  const f = filesById.get(loc.fileId)!;
  const rr = ciphertextRange(loc.offset, loc.offset + loc.length, f.P);
  const got = await decryptRange(f.ct.subarray(rr.from, rr.to), loc.offset, loc.offset + loc.length, f.P, f.key);
  check(hex(got) === hex(expected[k]), `range read of series ${loc.series + 1}'s instance from its file`);
}
const twoKeys = structuredClone(imagingStudy);
twoKeys.series[2].extension = [linkedFile(fileIdB64, addedKey)];
let rejected = false;
try {
  layout(twoKeys);
} catch {
  rejected = true;
}
check(rejected, "one file id with two keys rejected");

const rejects = (study: any) => {
  try {
    layout(study);
    return false;
  } catch {
    return true;
  }
};
const zeroLength = structuredClone(imagingStudy);
zeroLength.series[0].instance[0].extension[0].valueDecimal = 0;
check(rejects(zeroLength), "an instance length of 0 rejected");
const emptySeries = structuredClone(imagingStudy);
emptySeries.series[1].instance = [];
check(rejects(emptySeries), "a series without instances rejected");
const clash = structuredClone(imagingStudy);
clash.series[0].extension = [linkedFile(fileIdB64, addedKey)];
check(rejects(clash), "a series-level linked-file giving the study's file another key rejected");
const allOverride = structuredClone(imagingStudy);
allOverride.series = [allOverride.series[2]];
check(
  layout(allOverride).files.map((f) => f.id).join() === addedFileId,
  "a study-level linked-file no series uses names no file",
);

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
    { fullUrl: "urn:uuid:9a4e2c71-5b3d-4e8f-b0a2-6c7d8e9f0a13", resource: imagingStudy },
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

rmSync("fixtures/golden", { recursive: true, force: true });
mkdirSync("fixtures/golden", { recursive: true });
writeFileSync("fixtures/golden/bundle.jwe", bundleJwe);
writeFileSync("fixtures/golden/bundle.json", JSON.stringify(goldenBundle, null, 2) + "\n");
writeFileSync(`fixtures/golden/${fileIdB64}.bin`, ct);
writeFileSync(`fixtures/golden/${addedFileId}.bin`, addedCt);
writeFileSync(
  "fixtures/golden/vector.json",
  JSON.stringify(
    {
      shlKey: shlKeyB64,
      files: [
        {
          fileId: fileIdB64,
          key: b64urlEncode(fileKey),
          keyHex: hex(fileKey),
          instanceLengths: lengths,
          plaintextLength: total,
          ciphertextLength: ct.length,
          plaintextSha256: ptSha256,
          ciphertextSha256: ctSha256,
          recordTags,
          instance2Range: r,
        },
        {
          fileId: addedFileId,
          key: b64urlEncode(addedKey),
          keyHex: hex(addedKey),
          instanceLengths: [addedLength],
          plaintextLength: addedLength,
          ciphertextLength: addedCt.length,
          plaintextSha256: await sha256(addedPlaintext),
          ciphertextSha256: await sha256(addedCt),
          recordTags: [addedTag],
        },
      ],
      layout: lay.instances,
    },
    null,
    2,
  ) + "\n",
);
console.log("ok: wrote golden share fixtures to fixtures/golden/");
