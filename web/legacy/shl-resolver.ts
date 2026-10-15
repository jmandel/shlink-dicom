import { decode_shlink_wasm } from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

export interface ShlPayload {
  url: string;
  key: string;
  exp?: number;
  flag?: string;
  label?: string;
  v?: number;
}

export class PasscodeRequiredError extends Error {
  public remainingAttempts?: number;
  constructor(message: string, remainingAttempts?: number) {
    super(message);
    this.name = "PasscodeRequiredError";
    this.remainingAttempts = remainingAttempts;
  }
}

export class ShlResolver {
  public readonly shlinkUri: string;
  public readonly payload: ShlPayload;
  public readonly recipient: string;
  private passcode?: string;
  private baseUrl: string;
  private bundleEtag?: string;

  constructor(shlinkUri: string, recipient = "SHL Web Viewer", passcode?: string) {
    this.shlinkUri = shlinkUri;
    this.payload = JSON.parse(decode_shlink_wasm(shlinkUri));
    this.recipient = recipient;
    this.passcode = passcode;
    this.baseUrl = this.payload.url;
  }

  public isUMode(): boolean {
    return (this.payload.flag ?? "").includes("U");
  }

  public requiresPasscode(): boolean {
    return (this.payload.flag ?? "").includes("P");
  }

  public isLongLived(): boolean {
    return (this.payload.flag ?? "").includes("L");
  }

  public setPasscode(passcode: string) {
    this.passcode = passcode;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public seriesFileUrl(fileId: string): string {
    const u = new URL(`${fileId}.bin`, this.baseUrl);
    u.searchParams.set("recipient", this.recipient);
    return u.toString();
  }

  /** Resolves the SHL and returns the compact `bundle.jwe` string (or `null` if `304 Not Modified`). */
  public async fetchBundleJwe(ifNoneMatch = false): Promise<string | null> {
    if (this.isUMode()) {
      const u = new URL(this.payload.url);
      u.searchParams.set("recipient", this.recipient);
      const headers: Record<string, string> = {};
      if (ifNoneMatch && this.bundleEtag) {
        headers["If-None-Match"] = this.bundleEtag;
      }
      const res = await fetch(u.toString(), { headers });
      if (res.status === 304) return null;
      if (res.status === 404 || res.status === 410) {
        throw new Error("This link was revoked or has expired.");
      }
      if (!res.ok) {
        throw new Error(`This link was revoked or has expired (HTTP ${res.status}).`);
      }
      const etag = res.headers.get("ETag");
      if (etag) this.bundleEtag = etag;
      this.baseUrl = this.payload.url;
      return res.text();
    } else {
      await this.resolveManifestLocation();
      const res = await fetch(this.baseUrl);
      if (res.status === 404 || res.status === 410 || !res.ok) {
        throw new Error("This link was revoked or has expired.");
      }
      return res.text();
    }
  }

  /** Refreshes `this.baseUrl` by POSTing `{ recipient, passcode }` to the manifest `payload.url`. */
  public async resolveManifestLocation(): Promise<string> {
    if (this.requiresPasscode() && !this.passcode) {
      throw new PasscodeRequiredError("This link requires a passcode.");
    }
    const res = await fetch(this.payload.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: this.recipient,
        passcode: this.passcode,
      }),
    });
    if (res.status === 401) {
      let rem: number | undefined;
      try {
        const err = await res.json();
        rem = err.remainingAttempts;
      } catch {}
      throw new PasscodeRequiredError("Incorrect passcode.", rem);
    }
    if (res.status === 404 || res.status === 410) {
      throw new Error("This link was revoked or has expired.");
    }
    if (!res.ok) {
      throw new Error(`This link was revoked or has expired (HTTP ${res.status}).`);
    }
    const manifest = await res.json();
    const loc = manifest?.files?.[0]?.location;
    if (!loc || typeof loc !== "string") {
      throw new Error("Manifest missing files[0].location");
    }
    this.baseUrl = loc;
    return loc;
  }

  /**
   * Fetches a ciphertext byte range `[start, end)` from `{fileId}.bin`.
   * If in manifest/cap mode and `/cap/{token}/` returns `404` (e.g. 1-hour capability expired),
   * automatically re-resolves `POST payload.url` once and retries the Range request!
   */
  public async fetchSeriesRange(
    fileId: string,
    ciphertextStart: number,
    ciphertextEnd: number,
  ): Promise<{ bytes: Uint8Array; status: number }> {
    const rangeHeader = `bytes=${ciphertextStart}-${ciphertextEnd - 1}`;
    let url = this.seriesFileUrl(fileId);
    let res = await fetch(url, {
      headers: { Range: rangeHeader },
    });

    if (res.status === 404 && !this.isUMode()) {
      // Capability prefix likely expired or ended; refresh once and retry
      await this.resolveManifestLocation();
      url = this.seriesFileUrl(fileId);
      res = await fetch(url, {
        headers: { Range: rangeHeader },
      });
    }

    if (res.status === 404 || res.status === 410) {
      throw new Error("This link was revoked or has expired.");
    }
    if (!res.ok) {
      throw new Error(`Range GET ${fileId}.bin (${rangeHeader}) failed: HTTP ${res.status}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200 && buf.byteLength > ciphertextEnd - ciphertextStart) {
      return {
        bytes: buf.subarray(ciphertextStart, ciphertextEnd),
        status: 200,
      };
    }
    return { bytes: buf, status: res.status };
  }
}
