// Client for the share and link API (PLAN.md §5.2). The server sees only ciphertext, the owner
// Bundle encrypted under the owner key, and each link's encrypted Bundle.
import { b64urlDecode, b64urlEncode, utf8 } from "../../core/b64";
import { decryptJwe, encryptJwe } from "../../core/jwe";
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

  /** PUT one series file with upload progress (XMLHttpRequest: fetch has no upload progress). */
  putFile(fileId: string, bytes: Uint8Array, onProgress: (loaded: number) => void): Promise<void> {
    const cred = this.cred!;
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", `${this.base}/api/shares/${cred.sid}/files/${fileId}.bin`);
      x.setRequestHeader("Authorization", `Bearer ${cred.token}`);
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.setRequestHeader("X-Expected-Size", String(bytes.length));
      x.upload.onprogress = (e) => onProgress(e.loaded);
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) {
          onProgress(bytes.length);
          resolve();
        } else {
          let msg = `HTTP ${x.status}`;
          try {
            msg = JSON.parse(x.responseText).error ?? msg;
          } catch {}
          reject(new ApiError(x.status, msg));
        }
      };
      x.onerror = () => reject(new ApiError(0, "The upload was interrupted."));
      // A Blob body: the browser streams it from its blob store, and devtools protocol clients
      // don't get the whole file inlined in their network events.
      x.send(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    });
  }
}

// -------------------------------------------------------------------------------------- keys

/**
 * A link's SHL key, derived from the owner key and the link id (HKDF-SHA-256). The owner can
 * rebuild any of their links from the manage link alone; the server never sees either key.
 */
export async function linkKey(ownerKey: string, lid: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", b64urlDecode(ownerKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(`shl-dicom link key ${lid}`) },
    ikm,
    256,
  );
  return b64urlEncode(new Uint8Array(bits));
}

/** The label inside the link (shown to the recipient). At most 80 characters, as SHL requires. */
export function payloadLabel(recipient: string | null): string {
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

export async function readOwnerBundle(api: ShareApi, ownerKey: string): Promise<any> {
  return JSON.parse(fromUtf8(await decryptJwe(await api.getOwner(), ownerKey)));
}

// -------------------------------------------------------------------------- the manage link

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
