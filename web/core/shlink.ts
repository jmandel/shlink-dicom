// SMART Health Link URIs: parse `shlink:/…` (bare, or after a viewer prefix's `#`) and encode them.
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "./b64";

/** The decoded SHL payload (SMART Health Links spec). */
export interface ShlPayload {
  /** Manifest URL (no U flag) or the encrypted file itself (U flag). */
  url: string;
  /** 43-character base64url A256GCM key for the JWE file(s). */
  key: string;
  /** Expiry, seconds since the epoch. */
  exp?: number;
  /** Any of "L" (long-lived), "P" (passcode), "U" (direct file). */
  flag?: string;
  label?: string;
  v?: number;
}

export class InvalidLinkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidLinkError";
  }
}

/** Finds the `shlink:/…` part in a bare link, a viewer URL (`https://viewer/#shlink:/…`) or a hash. */
export function extractShlink(input: string): string | null {
  const s = input.trim();
  const i = s.indexOf("shlink:/");
  if (i < 0) return null;
  return s.slice(i).split(/\s/)[0];
}

export function parseShlink(input: string): ShlPayload {
  const link = extractShlink(input);
  if (!link) throw new InvalidLinkError("This is not a SMART Health Link.");
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8(b64urlDecode(link.slice("shlink:/".length))));
  } catch {
    throw new InvalidLinkError("This link is damaged: its contents could not be read.");
  }
  const p = payload as ShlPayload;
  if (!p || typeof p.url !== "string" || typeof p.key !== "string" || !isKey32(p.key)) {
    throw new InvalidLinkError("This link is missing its address or key.");
  }
  // SMART Health Links: version 1 (or none, which is 1) is the one this reader knows, as the Rust
  // reader (decode_shlink_uri) has it, and a link to the file itself (U) has no passcode (P).
  // Refused before any request is made.
  if (p.v !== undefined && p.v !== 1) throw new InvalidLinkError("This link uses a version of SMART Health Links this viewer does not read.");
  if ((p.flag ?? "").includes("U") && (p.flag ?? "").includes("P")) throw new InvalidLinkError("This link is not valid: a link to the file itself cannot need a passcode.");
  return p;
}

/** A base64url key of 32 bytes (43 characters, or 44 with padding). */
function isKey32(k: string): boolean {
  try {
    return b64urlDecode(k).length === 32;
  } catch {
    return false;
  }
}

export function encodeShlink(payload: ShlPayload, viewerPrefix?: string): string {
  const body = "shlink:/" + b64urlEncode(utf8(JSON.stringify(payload)));
  return viewerPrefix ? `${viewerPrefix.replace(/#+$/, "")}#${body}` : body;
}

export const hasFlag = (p: ShlPayload, f: "L" | "P" | "U") => (p.flag ?? "").includes(f);
