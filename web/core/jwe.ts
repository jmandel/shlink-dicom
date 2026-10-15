// Compact JWE as SMART Health Links use it: alg "dir", enc "A256GCM", optional zip "DEF".
// WebCrypto + (De)CompressionStream("deflate-raw"); runs in browsers, workers, Bun and Node 20+.
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "./b64";

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class JweError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JweError";
  }
}

/** Decrypts a compact JWE with a 32-byte key (raw bytes or base64url). Returns the plaintext bytes. */
export async function decryptJwe(compact: string, key: Uint8Array | string): Promise<Uint8Array> {
  const parts = compact.trim().split(".");
  if (parts.length !== 5) throw new JweError("not a compact JWE");
  const [hdrB64, ekB64, ivB64, ctB64, tagB64] = parts;
  let header: { alg?: string; enc?: string; zip?: string };
  try {
    header = JSON.parse(fromUtf8(b64urlDecode(hdrB64)));
  } catch {
    throw new JweError("unreadable JWE header");
  }
  if (header.alg !== "dir" || header.enc !== "A256GCM" || ekB64 !== "") {
    throw new JweError(`unsupported JWE ${header.alg}/${header.enc}`);
  }
  const raw = typeof key === "string" ? b64urlDecode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  const ct = b64urlDecode(ctB64);
  const tag = b64urlDecode(tagB64);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct);
  joined.set(tag, ct.length);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64urlDecode(ivB64), additionalData: utf8(hdrB64), tagLength: 128 },
        k,
        joined,
      ),
    );
  } catch {
    throw new JweError("the file did not decrypt with this link's key");
  }
  return header.zip === "DEF" ? inflateRaw(pt) : pt;
}

/** Encrypts bytes as a compact JWE (dir, A256GCM, zip DEF) under a 32-byte key. For sharers. */
export async function encryptJwe(
  plaintext: Uint8Array,
  key: Uint8Array | string,
  extraHeader: Record<string, unknown> = { cty: "application/fhir+json" },
): Promise<string> {
  const raw = typeof key === "string" ? b64urlDecode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt"]);
  const hdrB64 = b64urlEncode(utf8(JSON.stringify({ alg: "dir", enc: "A256GCM", zip: "DEF", ...extraHeader })));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(hdrB64), tagLength: 128 },
      k,
      (await deflateRaw(plaintext)) as BufferSource,
    ),
  );
  const ct = ctTag.subarray(0, ctTag.length - 16);
  const tag = ctTag.subarray(ctTag.length - 16);
  return [hdrB64, "", b64urlEncode(iv), b64urlEncode(ct), b64urlEncode(tag)].join(".");
}

/** 32 random bytes, base64url: a fresh SHL key or series key. */
export function randomKeyB64(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
