// Link resolution (SMART Health Links + PROPOSAL.md §10): U mode and manifest mode, passcodes,
// fresh /cap/ locations when a capability prefix expires, and Range reads of the encrypted files.
import { decryptJwe, JweError } from "./jwe";
import { hasFlag, parseShlink, type ShlPayload } from "./shlink";
import type { RangePlan } from "./range";

export type LinkFailure =
  /** The link's own `exp` has passed. */
  | "expired"
  /** The host answers 404/410: revoked, taken offline, or expired on the server. */
  | "unavailable"
  /** Too many wrong passcodes: the host no longer answers this link. */
  | "locked"
  /** The request never reached the host (device offline, DNS, CORS, connection reset). */
  | "network"
  /** The link or its file is damaged, or the key does not match. */
  | "invalid"
  /** Any other HTTP failure. */
  | "server";

export class LinkError extends Error {
  constructor(
    readonly reason: LinkFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** The link needs a passcode (none given yet, or the one given was wrong). */
export class PasscodeError extends Error {
  constructor(
    /** "required": none supplied yet. "incorrect": the host refused it. */
    readonly kind: "required" | "incorrect",
    /** Attempts the host will still accept, when it says. */
    readonly remainingAttempts?: number,
  ) {
    super(kind === "required" ? "This link needs a passcode." : "That passcode is not right.");
    this.name = "PasscodeError";
  }
}

/** One HTTP exchange, reported for network panels and logs. */
export interface RequestEvent {
  method: "GET" | "POST";
  url: string;
  range?: string;
  status: number;
  bytes: number;
  ms: number;
  /** What the request was for. */
  purpose: "manifest" | "bundle" | "file";
}

export interface ResolverOptions {
  /** Sent as `recipient` (manifest body and `?recipient=` on file reads). */
  recipient?: string;
  onRequest?: (e: RequestEvent) => void;
  fetch?: typeof fetch;
}

export interface OpenedLink {
  /** Decrypted Bundle bytes (UTF-8 JSON). */
  bundleBytes: Uint8Array;
  /** Where `{fileId}.bin` resolves: the U-mode url, or the manifest's `location`. */
  baseUrl: string;
  /** The manifest response, in manifest mode. */
  manifest: any | null;
}

const isNetworkError = (e: unknown) => e instanceof TypeError;

export class LinkResolver {
  readonly payload: ShlPayload;
  readonly recipient: string;
  private passcode?: string;
  private baseUrl: string | null = null;
  private refreshing: Promise<string> | null = null;
  private lockedOut = false;
  private sawWrongPasscode = false;
  private onRequest?: (e: RequestEvent) => void;
  private f: typeof fetch;

  constructor(link: string | ShlPayload, opts: ResolverOptions = {}) {
    this.payload = typeof link === "string" ? parseShlink(link) : link;
    this.recipient = opts.recipient ?? "SHL imaging viewer";
    this.onRequest = opts.onRequest;
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  get isDirect() {
    return hasFlag(this.payload, "U");
  }
  get needsPasscode() {
    return hasFlag(this.payload, "P");
  }
  get isLongLived() {
    return hasFlag(this.payload, "L");
  }
  get label() {
    return this.payload.label ?? null;
  }
  /** Expiry from the link payload, or null. */
  get expires(): Date | null {
    return typeof this.payload.exp === "number" ? new Date(this.payload.exp * 1000) : null;
  }
  /** The current base URL (null until open() succeeds). */
  get base() {
    return this.baseUrl;
  }

  /** Resolves the link and decrypts its Bundle. Throws PasscodeError or LinkError. */
  async open(passcode?: string): Promise<OpenedLink> {
    if (passcode !== undefined) this.passcode = passcode;
    const exp = this.expires;
    if (exp && exp.getTime() <= Date.now()) {
      throw new LinkError("expired", `This link expired on ${exp.toLocaleDateString()}.`);
    }
    let manifest: any = null;
    let bundleUrl: string;
    if (this.isDirect) {
      const u = new URL(this.payload.url);
      u.searchParams.set("recipient", this.recipient);
      bundleUrl = u.toString();
      this.baseUrl = this.payload.url;
    } else {
      manifest = await this.postManifest();
      bundleUrl = this.baseUrl!;
    }
    const res = await this.timedFetch(bundleUrl, { purpose: "bundle" });
    if (!res.ok) throw this.httpError(res.status);
    const jwe = await res.text();
    let bundleBytes: Uint8Array;
    try {
      bundleBytes = await decryptJwe(jwe, this.payload.key);
    } catch (e) {
      throw new LinkError("invalid", e instanceof JweError ? "This link's key does not open its file." : String(e));
    }
    return { bundleBytes, baseUrl: this.baseUrl!, manifest };
  }

  /** `{fileId}.bin` resolved against the base URL, with `?recipient=`. */
  fileUrl(fileId: string): string {
    if (!this.baseUrl) throw new Error("open() the link first");
    const u = new URL(`${fileId}.bin`, this.baseUrl);
    u.searchParams.set("recipient", this.recipient);
    return u.toString();
  }

  /**
   * Fetches the ciphertext a RangePlan names. In manifest mode a 404 means the capability prefix
   * may have expired: the link is re-resolved once (with the remembered passcode) and the read
   * retried. Checks that exactly the planned number of bytes arrived.
   */
  /** The ciphertext of a plan. `onProgress` gets the bytes received so far against the plan's length. */
  async fetchRange(plan: RangePlan, signal?: AbortSignal, onProgress?: (received: number, total: number) => void): Promise<Uint8Array> {
    const want = plan.ciphertextEnd - plan.ciphertextStart;
    const attempt = async () =>
      this.timedFetch(this.fileUrl(plan.fileId), {
        purpose: "file",
        range: plan.rangeHeader,
        signal,
      });
    let res = await attempt();
    if ((res.status === 404 || res.status === 403) && !this.isDirect) {
      await res.body?.cancel();
      await this.refreshLocation();
      res = await attempt();
    }
    if (res.status !== 206 && res.status !== 200) throw this.httpError(res.status);
    let bytes = onProgress && res.status === 206 && res.body ? await readCounting(res.body, want, onProgress) : new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) bytes = bytes.subarray(plan.ciphertextStart, plan.ciphertextEnd);
    if (bytes.byteLength !== want) {
      throw new LinkError("server", `The host sent ${bytes.byteLength} bytes where ${want} were expected.`);
    }
    return bytes;
  }

  /** Re-resolves the manifest for a fresh `location` (deduplicated across concurrent callers). */
  refreshLocation(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.postManifest()
        .then(() => this.baseUrl!)
        .finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  private async postManifest(): Promise<any> {
    if (this.lockedOut) throw new LinkError("locked", "Too many wrong passcodes. This link no longer opens.");
    if (this.needsPasscode && !this.passcode) throw new PasscodeError("required");
    const res = await this.timedFetch(this.payload.url, {
      purpose: "manifest",
      method: "POST",
      body: JSON.stringify({ recipient: this.recipient, ...(this.passcode ? { passcode: this.passcode } : {}) }),
    });
    if (res.status === 401) {
      let rem: number | undefined;
      try {
        const j = await res.json();
        if (typeof j?.remainingAttempts === "number") rem = j.remainingAttempts;
      } catch {}
      this.sawWrongPasscode = true;
      this.passcode = undefined;
      if (rem === 0) {
        this.lockedOut = true;
        throw new LinkError("locked", "Too many wrong passcodes. This link no longer opens.");
      }
      throw new PasscodeError("incorrect", rem);
    }
    if ((res.status === 404 || res.status === 410) && this.sawWrongPasscode) {
      this.lockedOut = true;
      throw new LinkError("locked", "Too many wrong passcodes. This link no longer opens.");
    }
    if (!res.ok) throw this.httpError(res.status);
    const manifest = await res.json().catch(() => null);
    const loc = manifest?.files?.find((f: any) => typeof f?.location === "string")?.location;
    if (!loc) throw new LinkError("invalid", "The host's answer did not say where the file is.");
    this.baseUrl = loc;
    return manifest;
  }

  private httpError(status: number): LinkError {
    if (status === 404 || status === 410) {
      return new LinkError("unavailable", "This link no longer works. It may have been revoked, taken offline or expired.", status);
    }
    return new LinkError("server", `The host could not answer (HTTP ${status}).`, status);
  }

  private async timedFetch(
    url: string,
    o: { purpose: RequestEvent["purpose"]; method?: "GET" | "POST"; body?: string; range?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const t0 = performance.now();
    const headers: Record<string, string> = {};
    if (o.range) headers.Range = o.range;
    if (o.body) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.f(url, {
        method: o.method ?? "GET",
        headers,
        body: o.body,
        signal: o.signal,
        // Encrypted files are immutable (§10), so the HTTP cache may keep them; manifests and Bundles may change.
        cache: o.purpose === "file" ? "default" : "no-store",
      });
    } catch (e) {
      if ((e as any)?.name === "AbortError") throw e;
      if (isNetworkError(e)) {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        throw new LinkError(
          "network",
          offline ? "This device is offline." : "The host could not be reached.",
        );
      }
      throw e;
    }
    if (this.onRequest) {
      const len = Number(res.headers.get("content-length") ?? 0);
      this.onRequest({
        method: o.method ?? "GET",
        url,
        range: o.range,
        status: res.status,
        bytes: len,
        ms: performance.now() - t0,
        purpose: o.purpose,
      });
    }
    return res;
  }
}

/** Reads a response body of `total` bytes, reporting what has arrived. */
async function readCounting(body: ReadableStream<Uint8Array>, total: number, onProgress: (received: number, total: number) => void): Promise<Uint8Array> {
  const out = new Uint8Array(total);
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > total) throw new LinkError("server", `The host sent more than the ${total} bytes expected.`);
    out.set(value, n);
    n += value.byteLength;
    onProgress(n, total);
  }
  return n === total ? out : out.subarray(0, n);
}
