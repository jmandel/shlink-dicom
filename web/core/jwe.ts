// Compact JWE as SMART Health Links use it: alg "dir", enc "A256GCM", optional zip "DEF". The
// checks match the Rust reader (crates/shl-dicom-core/src/jwe.rs): empty encrypted key, 12-byte IV,
// 16-byte tag, zip absent or "DEF".
// WebCrypto + (De)CompressionStream("deflate-raw"); runs in browsers, workers, Bun and Node 20+.
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "./b64";
import { inflateRawCapped, InflateLimitError } from "./inflate";

/** The longest compact JWE (a link's Bundle) a reader accepts: 64 MiB of characters. */
export const MAX_JWE_CHARS = 64 * 1024 * 1024;


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
  if (compact.length > MAX_JWE_CHARS) throw new JweError("the file is too large to be a link's Bundle");
  const parts = compact.trim().split(".");
  if (parts.length !== 5) throw new JweError("not a compact JWE");
  const [hdrB64, ekB64, ivB64, ctB64, tagB64] = parts;
  const dec = (x: string) => {
    try {
      return b64urlDecode(x);
    } catch {
      throw new JweError("not a compact JWE");
    }
  };
  let header: { alg?: string; enc?: string; zip?: string; cty?: string };
  try {
    header = JSON.parse(fromUtf8(b64urlDecode(hdrB64)));
  } catch {
    throw new JweError("unreadable JWE header");
  }
  if (header.alg !== "dir" || header.enc !== "A256GCM" || ekB64 !== "") {
    throw new JweError(`unsupported JWE ${header.alg}/${header.enc}`);
  }
  if (header.zip !== undefined && header.zip !== "DEF") throw new JweError(`unsupported JWE zip ${header.zip}`);
  // A link's files here are FHIR (spec/README.md §2): a JWE that says it is anything else is not read.
  if (header.cty !== undefined && header.cty !== "application/fhir+json") throw new JweError(`unsupported JWE content type ${header.cty}`);
  const raw = typeof key === "string" ? dec(key) : key;
  if (raw.length !== 32) throw new JweError("the key must be 32 bytes");
  const iv = dec(ivB64);
  if (iv.length !== 12) throw new JweError("JWE IV must be 12 bytes");
  const ct = dec(ctB64);
  const tag = dec(tagB64);
  if (tag.length !== 16) throw new JweError("JWE authentication tag must be 16 bytes");
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct);
  joined.set(tag, ct.length);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: utf8(hdrB64), tagLength: 128 },
        k,
        joined,
      ),
    );
  } catch {
    throw new JweError("the file did not decrypt with this link's key");
  }
  if (header.zip !== "DEF") return pt;
  try {
    return await inflateRawCapped(pt);
  } catch (e) {
    throw new JweError(e instanceof InflateLimitError ? "the file expands past 64 MiB" : "the file's DEFLATE data is damaged");
  }
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
