// Client for the share and link API (PLAN.md §5.2). The server sees only ciphertext, the owner
// Bundle encrypted under the owner key, and each link's encrypted Bundle.
import { b64urlDecode, b64urlEncode, utf8 } from "../../core/b64";
import { encryptJwe } from "../../core/jwe";
import { decryptBundle } from "../../core/reader";
import { encodeShlink } from "../../core/shlink";
import { fromUtf8 } from "../../core/b64";

export interface LinkResource {
  id: string;
  label: string | null;
  url: string;
  flag: string | null;
  exp: number | null;
  online: boolean;
  longLived: boolean;
  hasPasscode: boolean;
  remainingAttempts: number | null;
  hasBundle: boolean;
  allowedFiles: string[];
  createdAt: number;
  lastAccessAt: number | null;
  accessCount: number;
  openCount?: number;
  lastOpenedAt?: number | null;
  bytesServed?: number;
}

export interface ShareResource {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  readOnly: boolean;
  hasOwnerBundle: boolean;
  files: { name: string; size: number; uploadedAt: number }[];
  quota: { bytesUsed: number; bytesMax: number; filesMax: number };
  links: LinkResource[];
}

export interface AccessEvent {
  ts: number;
  lid: string | null;
  method: string;
  path: string;
  range: string | null;
  status: number;
  bytes: number;
  recipient: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the owner keeps: enough to manage the share from any device. */
export interface OwnerCredential {
  sid: string;
  token: string;
  ownerKey: string;
}

export class ShareApi {
  constructor(
    readonly base: string,
    readonly cred: { sid: string; token: string } | null = null,
  ) {}

  private async req(method: string, path: string, body?: BodyInit | object, type?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cred) headers.Authorization = `Bearer ${this.cred.token}`;
    let b: BodyInit | undefined;
    if (body !== undefined && (typeof body === "string" || body instanceof Uint8Array || body instanceof Blob)) {
      b = body as BodyInit;
      headers["Content-Type"] = type ?? "application/octet-stream";
    } else if (body !== undefined) {
      b = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body: b });
    } catch {
      throw new ApiError(0, "The server could not be reached.");
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {}
      throw new ApiError(res.status, msg);
    }
    return res;
  }

  private get s() {
    if (!this.cred) throw new Error("no share credential");
    return `/api/shares/${this.cred.sid}`;
  }

  async createShare(expiresAt: number | null): Promise<{ share: ShareResource; controlToken: string }> {
    return (await this.req("POST", "/api/shares", expiresAt ? { expiresAt } : {})).json();
  }
  async getShare(): Promise<ShareResource> {
    return (await this.req("GET", this.s)).json();
  }
  async setShareExpiry(expiresAt: number | null): Promise<ShareResource> {
    return (await this.req("PATCH", this.s, { expiresAt })).json();
  }
  async deleteShare(): Promise<void> {
    await this.req("DELETE", this.s);
  }
  async putOwner(jwe: string) {
    await this.req("PUT", `${this.s}/owner.jwe`, jwe, "application/jose");
  }
  async getOwner(): Promise<string> {
    return (await this.req("GET", `${this.s}/owner.jwe`)).text();
  }
  async createLink(o: { label: string | null; passcode?: string; exp: number | null; longLived: boolean; allowedFiles: string[] }): Promise<LinkResource> {
    return (await this.req("POST", `${this.s}/links`, { ...o, passcode: o.passcode || undefined, exp: o.exp ?? undefined })).json();
  }
  async putLinkBundle(lid: string, jwe: string): Promise<LinkResource> {
    return (await this.req("PUT", `${this.s}/links/${lid}/bundle.jwe`, jwe, "application/jose")).json();
  }
  /** A link's Bundle JWE as stored, for its owner; null when the link has none. */
  async getLinkBundle(lid: string): Promise<string | null> {
    try {
      return await (await this.req("GET", `${this.s}/links/${lid}/bundle`)).text();
    } catch (x) {
      if (x instanceof ApiError && x.status === 404) return null;
      throw x;
    }
  }
  async patchLink(lid: string, patch: { label?: string | null; exp?: number | null; online?: boolean; allowedFiles?: string[] }): Promise<LinkResource> {
    return (await this.req("PATCH", `${this.s}/links/${lid}`, patch)).json();
  }
  async deleteLink(lid: string) {
    await this.req("DELETE", `${this.s}/links/${lid}`);
  }
  async endSessions(lid: string) {
    await this.req("POST", `${this.s}/links/${lid}/end-sessions`, {});
  }
  async access(o: { lid?: string; limit?: number } = {}): Promise<AccessEvent[]> {
    const q = new URLSearchParams();
    if (o.lid) q.set("lid", o.lid);
    if (o.limit) q.set("limit", String(o.limit));
    return (await (await this.req("GET", `${this.s}/access?${q}`)).json()).events;
  }

  // Uploads of the encrypted files follow the IETF resumable uploads draft (draft-ietf-httpbis-resumable-upload):
  // PUT with Upload-Complete creates the upload, HEAD reports Upload-Offset, PATCH appends.

  private fileUrl(fileId: string) {
    return `${this.base}${this.s}/files/${fileId}.bin`;
  }

  /** Where an upload stands; null when the server has none. Times out after `timeoutMs`. */
  async uploadOffset(fileId: string, timeoutMs = 20000): Promise<{ offset: number; length: number | null; complete: boolean } | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.fileUrl(fileId), { method: "HEAD", headers: { Authorization: `Bearer ${this.cred!.token}` }, cache: "no-store", signal: ctl.signal });
    } catch {
      throw new ApiError(0, "The server could not be reached.");
    } finally {
      clearTimeout(t);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    const len = res.headers.get("Upload-Length");
    return { offset: Number(res.headers.get("Upload-Offset") ?? 0), length: len === null ? null : Number(len), complete: res.headers.get("Upload-Complete") === "?1" };
  }

  /** Deletes an uploaded file, whole or in part (404: there was none). */
  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.req("DELETE", `${this.s}/files/${fileId}.bin`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }

  /** Creates a resumable upload (no content yet), of `length` bytes or of a length not known yet. */
  async createUpload(fileId: string, length: number | null): Promise<void> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await fetch(this.fileUrl(fileId), {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.cred!.token}`, "Upload-Complete": "?0", ...(length === null ? {} : { "Upload-Length": String(length) }) },
        body: new Uint8Array(0),
        signal: ctl.signal,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (await res.json()).error ?? msg;
        } catch {}
        throw new ApiError(res.status, msg);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(0, "The server could not be reached.");
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Appends `bytes` at `offset` (PATCH, application/partial-upload), with upload progress
   * (XMLHttpRequest: fetch has no upload progress). A request with no progress for `stallMs`
   * is abandoned and fails as a network error. Returns the server's new offset. `length` is the
   * file's whole length, sent when known (an upload begun without one learns it this way).
   */
  appendUpload(
    fileId: string,
    offset: number,
    bytes: Uint8Array,
    complete: boolean,
    onProgress: (loaded: number) => void,
    length: number | null = null,
    stallMs = 20000,
  ): Promise<{ offset: number; complete: boolean }> {
    const cred = this.cred!;
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      let timer = 0;
      const arm = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          x.abort();
          reject(new ApiError(0, "The connection stalled."));
        }, stallMs);
      };
      x.open("PATCH", this.fileUrl(fileId));
      x.setRequestHeader("Authorization", `Bearer ${cred.token}`);
      x.setRequestHeader("Content-Type", "application/partial-upload");
      x.setRequestHeader("Upload-Offset", String(offset));
      x.setRequestHeader("Upload-Complete", complete ? "?1" : "?0");
      if (length !== null) x.setRequestHeader("Upload-Length", String(length));
      x.upload.onprogress = (e) => {
        arm();
        onProgress(e.loaded);
      };
      // Once the body is sent, allow the server time to write and answer.
      x.upload.onload = arm;
      x.onload = () => {
        clearTimeout(timer);
        let body: any = {};
        try {
          body = JSON.parse(x.responseText);
        } catch {}
        const at = x.getResponseHeader("Upload-Offset");
        if (x.status >= 200 && x.status < 300) {
          onProgress(bytes.length);
          resolve({ offset: at !== null ? Number(at) : offset + bytes.length, complete: x.getResponseHeader("Upload-Complete") === "?1" });
        } else {
          const err = new ApiError(x.status, body.error ?? body.title ?? `HTTP ${x.status}`);
          if (at !== null) (err as ApiError & { offset?: number }).offset = Number(at);
          reject(err);
        }
      };
      x.onerror = () => {
        clearTimeout(timer);
        reject(new ApiError(0, "The connection was lost."));
      };
      x.onabort = () => clearTimeout(timer);
      arm();
      // As a Blob: Chromium sends a typed-array body through a slow path (about 14 MB/s, and
      // 120 ms of main thread per 8 MiB); a Blob of the same bytes goes at 170+ MB/s.
      x.send(new Blob([bytes as BlobPart]));
    });
  }
}

// -------------------------------------------------------------------------------------- keys

/**
 * A link's SHL key, derived from the owner key and the link id (HKDF-SHA-256). The owner can
 * rebuild any of their links from the owner link (the manage URL) alone; the server never sees either key.
 */
async function linkKey(ownerKey: string, lid: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", b64urlDecode(ownerKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(`shl-dicom link key ${lid}`) },
    ikm,
    256,
  );
  return b64urlEncode(new Uint8Array(bits));
}

/** The label inside the link (shown to the recipient). At most 80 characters, as SHL requires. */
function payloadLabel(recipient: string | null): string {
  const r = (recipient ?? "").trim();
  const s = r ? `Imaging for ${r}` : "Shared imaging";
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

/** The full link for a link resource. */
export async function shlinkFor(link: LinkResource, ownerKey: string, viewerPrefix: string): Promise<string> {
  return encodeShlink(
    {
      url: link.url,
      key: await linkKey(ownerKey, link.id),
      ...(link.exp ? { exp: link.exp } : {}),
      ...(link.flag ? { flag: link.flag } : {}),
      label: payloadLabel(link.label),
      v: 1,
    },
    viewerPrefix,
  );
}

/** Encrypts a link Bundle under the link's key and uploads it. */
export async function publishLinkBundle(api: ShareApi, ownerKey: string, lid: string, bundle: any): Promise<LinkResource> {
  const jwe = await encryptJwe(utf8(JSON.stringify(bundle)), await linkKey(ownerKey, lid));
  return api.putLinkBundle(lid, jwe);
}

/** A link's Bundle, decrypted with its key; null when the link has none. */
export async function readLinkBundle(api: ShareApi, ownerKey: string, lid: string): Promise<any | null> {
  const jwe = await api.getLinkBundle(lid);
  return jwe === null ? null : JSON.parse(fromUtf8(await decryptBundle(jwe, await linkKey(ownerKey, lid))));
}

export async function readOwnerBundle(api: ShareApi, ownerKey: string): Promise<any> {
  return JSON.parse(fromUtf8(await decryptBundle(await api.getOwner(), ownerKey)));
}

// ----------------------------------------------------------- the owner link (manage URL)

export function manageUrl(siteManageUrl: string, c: OwnerCredential): string {
  return `${siteManageUrl}#share=${c.sid}&token=${c.token}&key=${c.ownerKey}`;
}

export function parseManageHash(hash: string): OwnerCredential | null {
  const q = new URLSearchParams(hash.replace(/^.*#/, ""));
  const sid = q.get("share"), token = q.get("token"), ownerKey = q.get("key");
  if (!sid || !token || !ownerKey) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(sid) || !/^[A-Za-z0-9_-]{43}$/.test(ownerKey)) return null;
  return { sid, token, ownerKey };
}

// ------------------------------------------------------------------ shares saved in this browser

export interface SavedShare extends OwnerCredential {
  title: string;
  createdAt: number;
  apiBase: string;
}

const STORE = "shl-dicom-shares";

export function savedShares(): SavedShare[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && x.sid && x.token && x.ownerKey) : [];
  } catch {
    return [];
  }
}

/** Returns false when this browser does not keep it (private mode, storage blocked). */
export function saveShare(s: SavedShare): boolean {
  try {
    const all = savedShares().filter((x) => x.sid !== s.sid);
    all.unshift(s);
    localStorage.setItem(STORE, JSON.stringify(all.slice(0, 50)));
    return savedShares().some((x) => x.sid === s.sid);
  } catch {
    return false;
  }
}

export function forgetShare(sid: string) {
  try {
    localStorage.setItem(STORE, JSON.stringify(savedShares().filter((x) => x.sid !== sid)));
  } catch {}
}
