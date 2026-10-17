// Compact JWE as SMART Health Links use it, for sharers: alg "dir", enc "A256GCM", zip "DEF", cty
// application/fhir+json. Reading one is the reader module's (reader.ts decryptBundle / openBundle:
// crates/shl-dicom-reader). WebCrypto + CompressionStream("deflate-raw"); browsers, workers, Bun.
import { b64urlDecode, b64urlEncode, utf8 } from "./b64";

/**
 * The longest compact JWE (a link's Bundle) a reader takes in: a 64 MiB Bundle in base64url and
 * a header, as the reader module counts it (crates/shl-dicom-core/src/jwe.rs MAX_JWE_CHARS).
 */
export const MAX_JWE_CHARS = Math.ceil((64 * 1024 * 1024) / 3) * 4 + 4096;

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

/** 32 random bytes, base64url: a fresh SHL key or file key. */
export function randomKeyB64(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
