// Reference implementation of spec/README.md §8.1 (where each instance's bytes are) and §9 (how a
// linked file is encrypted). WebCrypto (AES-GCM) only; runs in Bun, Deno, Node 20+ and browsers.

const SD = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/";
export const PROFILE_URL = SD + "dicom-imaging-study";
export const EXT_LINKED_FILE = SD + "linked-file";
export const EXT_INSTANCE_LENGTH = SD + "instance-length";

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

export async function importFileKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) throw new Error("file key must be 32 bytes");
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

export async function encryptFile(plaintext: Uint8Array, fileKey: Uint8Array): Promise<Uint8Array> {
  const key = await importFileKey(fileKey);
  const n = recordCount(plaintext.length);
  const out = new Uint8Array(ciphertextLength(plaintext.length));
  for (let i = 0; i < n; i++) {
    const chunk = plaintext.subarray(i * RECORD_PLAINTEXT, Math.min(plaintext.length, (i + 1) * RECORD_PLAINTEXT));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i) }, key, chunk));
    out.set(ct, i * RECORD_CIPHERTEXT);
  }
  return out;
}

/** The ciphertext byte range holding plaintext bytes [start, end) of a file. */
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
  fileKey: Uint8Array,
): Promise<Uint8Array> {
  const r = ciphertextRange(start, end, plaintextLength);
  if (ciphertext.length !== r.to - r.from) throw new Error(`expected ${r.to - r.from} ciphertext bytes, got ${ciphertext.length}`);
  const key = await importFileKey(fileKey);
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

/** Where one instance's bytes are: plaintext [offset, offset + length) of file `fileId`. */
export interface InstanceLocation {
  series: number;
  instance: number;
  fileId: string;
  offset: number;
  length: number;
}

export interface LinkedFile {
  id: string;
  key: string;
  /** Plaintext length P: the final running offset (§8.1). */
  plaintextLength: number;
}

function linkedFile(el: any): { id: string; key: string } | null {
  const ext = (el?.extension ?? []).find((e: any) => e?.url === EXT_LINKED_FILE);
  if (!ext) return null;
  const sub = (name: string) => (ext.extension ?? []).find((e: any) => e?.url === name)?.valueString;
  const id = sub("id"), key = sub("key");
  if (!/^[A-Za-z0-9_-]{22}$/.test(id ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(key ?? "")) throw new Error("bad linked-file");
  return { id, key };
}

/**
 * spec/README.md §8.1: resolves each series' linked file (its own, else the study's) and walks the
 * series and instances in array order, keeping a running offset per file.
 */
export function layout(imagingStudy: any): { files: LinkedFile[]; instances: InstanceLocation[] } {
  const studyFile = linkedFile(imagingStudy);
  const files = new Map<string, LinkedFile>();
  // A series-level linked-file naming the study's file must give the same key.
  if (studyFile) files.set(studyFile.id, { ...studyFile, plaintextLength: 0 });
  const instances: InstanceLocation[] = [];
  (imagingStudy.series ?? []).forEach((se: any, s: number) => {
    const lf = linkedFile(se) ?? studyFile;
    if (!lf) throw new Error(`series ${s} has no linked file`);
    let f = files.get(lf.id);
    if (!f) files.set(lf.id, (f = { id: lf.id, key: lf.key, plaintextLength: 0 }));
    else if (f.key !== lf.key) throw new Error(`file ${lf.id} is given two keys`);
    if (!se.instance?.length) throw new Error(`series ${s} lists no instances`);
    (se.instance ?? []).forEach((inst: any, i: number) => {
      const length = Number((inst.extension ?? []).find((e: any) => e?.url === EXT_INSTANCE_LENGTH)?.valueDecimal);
      if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`series ${s} instance ${i} has no length`);
      instances.push({ series: s, instance: i, fileId: lf.id, offset: f.plaintextLength, length });
      f.plaintextLength += length;
    });
  });
  // Only files some series uses (a study-level linked-file no series uses names nothing).
  const used = new Set(instances.map((x) => x.fileId));
  return { files: [...files.values()].filter((f) => used.has(f.id)), instances };
}
