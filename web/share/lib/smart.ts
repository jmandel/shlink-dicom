// SMART Imaging Access client (https://build.fhir.org/ig/argonautproject/smart-imaging/):
// discovery, a standalone SMART App Launch with PKCE as a public client, ImagingStudy search with
// the WADO-RS Endpoint, and DICOMweb retrieval with the same token. Only fetch and WebCrypto.
// Adapted from imaging-sandbox/test/client.ts.

const APP_LAUNCH = "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch";
const CLIENT_ID = "shlink-dicom-share";
const SCOPE = "launch/patient patient/Patient.rs patient/DiagnosticReport.rs patient/ImagingStudy.rs";

export interface Discovery {
  smart: Record<string, any>;
  clinicalBase: string;
  imagingBase: string;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `url` when it is https: (or http: on this machine, for local testing); otherwise an Error that
 * names `what`. The portal's token goes to these addresses, so it never travels in the clear.
 */
export function secureUrl(url: unknown, what: string): string {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`The portal's ${what} is not a valid address.`);
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname))) return String(url);
  throw new Error(`The portal's ${what} must use https (${u.protocol}//${u.host}).`);
}

export async function discover(clinicalBase: string): Promise<Discovery> {
  const base = secureUrl(clinicalBase.trim(), "address").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/.well-known/smart-configuration`, { headers: { accept: "application/json" } });
  } catch {
    throw new Error("The portal could not be reached.");
  }
  if (!res.ok) throw new Error(`The portal has no SMART configuration (HTTP ${res.status}).`);
  const smart = await res.json();
  const has = (caps: unknown) => Array.isArray(caps) && caps.includes("smart-imaging-access") && caps.includes(APP_LAUNCH);
  let imagingBase: string | undefined;
  if (has(smart.capabilities)) imagingBase = base;
  for (const ae of smart.associated_endpoints ?? []) if (!imagingBase && has(ae.capabilities)) imagingBase = String(ae.url).replace(/\/+$/, "");
  if (!imagingBase) throw new Error("This portal does not offer SMART Imaging Access.");
  if (!smart.code_challenge_methods_supported?.includes("S256")) throw new Error("This portal does not support PKCE (S256).");
  secureUrl(imagingBase, "imaging server address");
  secureUrl(smart.authorization_endpoint, "authorization endpoint");
  secureUrl(smart.token_endpoint, "token endpoint");
  return { smart, clinicalBase: base, imagingBase };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function authorizeUrl(d: Discovery, o: { redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(d.smart.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", o.state);
  u.searchParams.set("aud", d.clinicalBase);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(d: Discovery, o: { code: string; verifier: string; redirectUri: string }): Promise<Record<string, any>> {
  const res = await fetch(d.smart.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, code_verifier: o.verifier, client_id: CLIENT_ID, redirect_uri: o.redirectUri }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The portal refused the sign-in (${body.error ?? res.status}).`);
  return body;
}

/** GET with the IG's delayed-results pattern: on 503 with Retry-After, wait and repeat. */
async function getWithRetry(url: string, headers: Record<string, string>, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers });
    const wait = Number(res.headers.get("retry-after"));
    if (res.status !== 503 || i >= tries - 1 || !Number.isFinite(wait)) return res;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
  }
}

export async function fhirGet(url: string, token: string): Promise<any> {
  const res = await getWithRetry(url, { authorization: `Bearer ${token}`, accept: "application/fhir+json" });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

/** Follows Bundle.link[next] pages. */
export async function fhirSearchAll(url: string, token: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < 20; page++) {
    const b = await fhirGet(next, token);
    out.push(b);
    next = b.link?.find((l: any) => l.relation === "next")?.url;
  }
  return out;
}

function resolveInBundle(bundle: any, entry: any, ref: string): any | undefined {
  const byFullUrl = (u: string) => bundle.entry?.find((e: any) => e.fullUrl === u)?.resource;
  if (ref.startsWith("#")) return entry.resource.contained?.find((c: any) => `#${c.id}` === ref);
  if (/^urn:(uuid|oid):/.test(ref) || /^https?:\/\//.test(ref)) return byFullUrl(ref);
  const m = String(entry.fullUrl ?? "").match(/^(.*\/)[A-Za-z]+\/[^/]+$/);
  if (m) {
    const hit = byFullUrl(m[1] + ref);
    if (hit) return hit;
  }
  const [type, id] = ref.split("/");
  return bundle.entry?.find((e: any) => e.resource?.resourceType === type && e.resource?.id === id)?.resource;
}

export interface FoundStudy {
  study: any;
  studyUID: string;
  wadoBase: string;
}

export function studiesFromBundle(bundle: any): FoundStudy[] {
  const out: FoundStudy[] = [];
  for (const entry of bundle.entry ?? []) {
    const st = entry.resource;
    if (st?.resourceType !== "ImagingStudy" || entry.search?.mode === "include") continue;
    const uid = st.identifier?.find((i: any) => i.system === "urn:dicom:uid")?.value as string | undefined;
    if (!uid?.startsWith("urn:oid:")) continue;
    let wadoBase: string | undefined;
    for (const ref of st.endpoint ?? []) {
      const ep = resolveInBundle(bundle, entry, ref.reference);
      if (ep?.resourceType === "Endpoint" && ep.connectionType?.code === "dicom-wado-rs" && ep.status === "active") {
        wadoBase = String(ep.address).replace(/\/+$/, "");
        break;
      }
    }
    if (wadoBase) out.push({ study: st, studyUID: uid.slice("urn:oid:".length), wadoBase });
  }
  return out;
}

/**
 * What a WADO-RS retrieve asks for (SMART Imaging Access, transfer syntax negotiation): lossless
 * compressed first, then anything as stored. A server that can re-encode uncompressed images sends
 * JPEG Lossless SV1 or JPEG 2000 Lossless; one that can't sends what it has. Each part says its
 * own transfer syntax.
 */
export const DICOM_ACCEPT = [
  'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.70',
  'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.90; q=0.9',
  'multipart/related; type="application/dicom"; transfer-syntax=*; q=0.5',
].join(", ");

/** One part of a WADO-RS response: its body as chunks, and the transfer syntax its Content-Type declares. */
export interface WadoPart {
  transferSyntax: string | null;
  body: AsyncGenerator<Uint8Array>;
}

/** The transfer-syntax parameter of a part's Content-Type, if any. */
export function partTransferSyntax(contentType: string | undefined): string | null {
  const m = /;\s*transfer-syntax\s*=\s*"?([0-9.]+)"?/i.exec(contentType ?? "");
  return m ? m[1] : null;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Fetches attachment URLs with the token and puts the bytes inline (recipients can't reach the portal). */
export async function inlineAttachments(report: any, token: string): Promise<any> {
  const forms: any[] = [];
  for (const a of report.presentedForm ?? []) {
    if (a.data || !a.url) {
      if (a.data) forms.push(a);
      continue;
    }
    try {
      const res = await fetch(a.url, { headers: { authorization: `Bearer ${token}`, accept: a.contentType ?? "*/*" } });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { url: _drop, ...rest } = a;
      forms.push({ ...rest, data: btoa(s), size: bytes.length });
    } catch {}
  }
  return { ...report, presentedForm: forms.length ? forms : undefined };
}

/**
 * WADO-RS retrieve, streamed: yields each part's bytes as chunks while the response arrives, so a
 * series is never held whole. Consume each part before asking for the next.
 */
export async function* wadoRetrieveParts(url: string, token: string, signal?: AbortSignal): AsyncGenerator<WadoPart> {
  const res = await getWithRetry(url, { authorization: `Bearer ${token}`, accept: DICOM_ACCEPT });
  if (!res.ok || !res.body) throw new Error(`WADO-RS ${res.status} for ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  const m = ct.match(/boundary=("?)([^";]+)\1/i);
  if (!ct.startsWith("multipart/related") || !m) throw new Error(`WADO-RS answered ${ct}`);
  const enc = new TextEncoder();
  const delim = enc.encode(`--${m[2]}`);
  const closeDelim = enc.encode(`\r\n--${m[2]}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let ended = false;
  const more = async () => {
    signal?.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      return false;
    }
    const b = new Uint8Array(buf.length + value.length);
    b.set(buf);
    b.set(value, buf.length);
    buf = b;
    return true;
  };
  const need = async (n: number) => {
    while (buf.length < n) if (!(await more())) throw new Error("multipart: response ended early");
  };
  const find = async (needle: Uint8Array, from = 0): Promise<number> => {
    for (;;) {
      const i = indexOf(buf, needle, from);
      if (i >= 0) return i;
      from = Math.max(0, buf.length - needle.length + 1);
      if (!(await more())) return -1;
    }
  };
  try {
    let pos = await find(delim);
    if (pos < 0) throw new Error("multipart: opening boundary not found");
    buf = buf.subarray(pos);
    for (;;) {
      await need(delim.length + 2);
      if (buf[delim.length] === 0x2d && buf[delim.length + 1] === 0x2d) return; // closing --
      buf = buf.subarray(delim.length + 2);
      const headEnd = await find(enc.encode("\r\n\r\n"));
      if (headEnd < 0) throw new Error("multipart: part headers not terminated");
      const headers: Record<string, string> = {};
      for (const line of new TextDecoder().decode(buf.subarray(0, headEnd)).split("\r\n")) {
        const c = line.indexOf(":");
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      buf = buf.subarray(headEnd + 4);
      const cl = headers["content-length"] !== undefined ? Number(headers["content-length"]) : NaN;
      let consumed = false;
      const body = async function* (): AsyncGenerator<Uint8Array> {
        if (Number.isFinite(cl)) {
          let left = cl;
          while (left > 0) {
            if (!buf.length && !(await more())) throw new Error("multipart: part ended early");
            const out = buf.subarray(0, Math.min(left, buf.length));
            buf = buf.subarray(out.length);
            left -= out.length;
            yield out.slice();
          }
          await need(2);
          buf = buf.subarray(2); // CRLF before the next delimiter
        } else {
          // No length: find the delimiter (the part is held until then).
          const end = await find(closeDelim);
          if (end < 0) throw new Error("multipart: closing boundary not found");
          yield buf.slice(0, end);
          buf = buf.subarray(end + 2);
        }
        consumed = true;
      };
      yield { transferSyntax: partTransferSyntax(headers["content-type"]), body: body() };
      if (!consumed) throw new Error("multipart: part not read");
    }
  } finally {
    reader.cancel().catch(() => {});
    void ended;
  }
}
