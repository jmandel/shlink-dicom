export interface ShareFileEntry {
  name: string;
  size: number;
  uploadedAt: number;
}

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
}

export interface ShareResource {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  readOnly: boolean;
  hasOwnerBundle: boolean;
  files: ShareFileEntry[];
  quota: {
    bytesUsed: number;
    bytesMax: number;
    filesMax: number;
  };
  links: LinkResource[];
}

export interface DemoShareInfo {
  id: string;
  title: string;
  description: string;
  shlinkUri: string;
  passcodeHint: string | null;
  readOnly: boolean;
  share: ShareResource;
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

export class ApiClient {
  public readonly baseUrl: string;

  constructor(baseUrl?: string) {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const fromQuery = params.get("api");
    this.baseUrl = (baseUrl || fromQuery || globalThis.location?.origin || "http://localhost:3000").replace(/\/+$/, "");
  }

  async getDemoShares(): Promise<DemoShareInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/demo-shares`);
    if (!res.ok) throw new Error(`GET /api/demo-shares failed: ${res.status}`);
    const data = await res.json();
    return data.shares ?? [];
  }

  async createShare(): Promise<{ share: ShareResource; controlToken: string }> {
    const res = await fetch(`${this.baseUrl}/api/shares`, { method: "POST" });
    if (!res.ok) throw new Error(`POST /api/shares failed: ${res.status}`);
    return res.json();
  }

  async cloneShare(sourceSid: string): Promise<{ share: ShareResource; controlToken: string }> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sourceSid}/clone`, { method: "POST" });
    if (!res.ok) throw new Error(`Clone share failed: ${res.status}`);
    return res.json();
  }

  async getShare(sid: string, controlToken: string): Promise<ShareResource> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}`, {
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    if (!res.ok) throw new Error(`GET share failed: ${res.status}`);
    return res.json();
  }

  async putOwnerBundle(sid: string, controlToken: string, ownerJwe: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/owner.jwe`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/jose",
      },
      body: ownerJwe,
    });
    if (!res.ok) throw new Error(`PUT owner.jwe failed: ${res.status}`);
  }

  async getOwnerBundle(sid: string, controlToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/owner.jwe`, {
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    if (!res.ok) throw new Error(`GET owner.jwe failed: ${res.status}`);
    return res.text();
  }

  async putSeriesFile(
    sid: string,
    controlToken: string,
    fileId: string,
    ciphertext: Uint8Array,
  ): Promise<ShareFileEntry> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/files/${fileId}.bin`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/octet-stream",
        "X-Expected-Size": String(ciphertext.byteLength),
      },
      body: ciphertext,
    });
    if (!res.ok) throw new Error(`PUT ${fileId}.bin failed: ${res.status}`);
    return res.json();
  }

  async createLink(
    sid: string,
    controlToken: string,
    opts: {
      label?: string;
      passcode?: string;
      exp?: number;
      longLived?: boolean;
      allowedFiles: string[];
    },
  ): Promise<LinkResource> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`Create link failed: ${res.status}`);
    return res.json();
  }

  async putLinkBundle(
    sid: string,
    lid: string,
    controlToken: string,
    bundleJwe: string,
  ): Promise<LinkResource> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/links/${lid}/bundle.jwe`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/jose",
      },
      body: bundleJwe,
    });
    if (!res.ok) throw new Error(`PUT link bundle.jwe failed: ${res.status}`);
    return res.json();
  }

  async patchLink(
    sid: string,
    lid: string,
    controlToken: string,
    patch: {
      label?: string | null;
      exp?: number | null;
      online?: boolean;
      allowedFiles?: string[];
    },
  ): Promise<LinkResource> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/links/${lid}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`PATCH link failed: ${res.status}`);
    return res.json();
  }

  async deleteLink(sid: string, lid: string, controlToken: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/links/${lid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    if (!res.ok) throw new Error(`DELETE link failed: ${res.status}`);
  }

  async endLinkSessions(sid: string, lid: string, controlToken: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/links/${lid}/end-sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) throw new Error(`end-sessions failed: ${res.status}`);
    const data = await res.json();
    return data.revokedCount ?? 0;
  }

  async getAccessHistory(sid: string, controlToken: string): Promise<AccessEvent[]> {
    const res = await fetch(`${this.baseUrl}/api/shares/${sid}/access`, {
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.events ?? [];
  }

  subscribeEvents(
    sid: string,
    controlToken: string,
    onEvent: (ev: AccessEvent) => void,
  ): AbortController {
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/shares/${sid}/events`, {
          headers: { Authorization: `Bearer ${controlToken}` },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const block of parts) {
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) {
                const jsonStr = line.slice(5).trim();
                try {
                  onEvent(JSON.parse(jsonStr));
                } catch {}
              }
            }
          }
        }
      } catch {}
    })();
    return abort;
  }
}
