// SMART Health Link URIs: find `shlink:/…` in text and encode them. Links are read and checked by
// the reader module (reader.ts parseLink: crates/shl-dicom-reader).
import { b64urlEncode, utf8 } from "./b64";

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
  constructor(
    msg: string,
    /** The reader's code (crates/shl-dicom-reader/README.md). */
    readonly code = "",
  ) {
    super(msg);
    this.name = "InvalidLinkError";
  }
}

/** What to tell the person for each of the reader's link codes. */
const LINK_MESSAGES: Record<string, string> = {
  "not-a-link": "This is not a SMART Health Link.",
  damaged: "This link is damaged: its contents could not be read.",
  "missing-url-or-key": "This link is missing its address or key.",
  "bad-key": "This link is missing its address or key.",
  "bad-flag": "This link is damaged: its contents could not be read.",
  "bad-exp": "This link is damaged: its contents could not be read.",
  "u-with-p": "This link is not valid: a link to the file itself cannot need a passcode.",
  version: "This link uses a version of SMART Health Links this viewer does not read.",
};

/** The InvalidLinkError for a code parseLink failed with. */
export function invalidLink(code: string): InvalidLinkError {
  return new InvalidLinkError(LINK_MESSAGES[code] ?? "This link is damaged: its contents could not be read.", code);
}

/** Finds the `shlink:/…` part in a bare link, a viewer URL (`https://viewer/#shlink:/…`) or a hash. */
export function extractShlink(input: string): string | null {
  const s = input.trim();
  const i = s.indexOf("shlink:/");
  if (i < 0) return null;
  return s.slice(i).split(/\s/)[0];
}

export function encodeShlink(payload: ShlPayload, viewerPrefix?: string): string {
  const body = "shlink:/" + b64urlEncode(utf8(JSON.stringify(payload)));
  return viewerPrefix ? `${viewerPrefix.replace(/#+$/, "")}#${body}` : body;
}
