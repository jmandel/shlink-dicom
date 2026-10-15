// base64url (RFC 4648 §5, no padding) helpers used by the link, JWE and Bundle code.

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
