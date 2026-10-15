// SMART Imaging Access client (https://build.fhir.org/ig/argonautproject/smart-imaging/):
// discovery, a standalone SMART App Launch with PKCE as a public client, ImagingStudy search with
// the WADO-RS Endpoint, and DICOMweb retrieval with the same token. Only fetch and WebCrypto.
// Adapted from imaging-sandbox/test/client.ts.

export const APP_LAUNCH = "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch";
export const CLIENT_ID = "shlink-dicom-share";
export const SCOPE = "launch/patient patient/Patient.rs patient/DiagnosticReport.rs patient/ImagingStudy.rs";

export interface Discovery {
  smart: Record<string, any>;
  clinicalBase: string;
  imagingBase: string;
}

export async function discover(clinicalBase: string): Promise<Discovery> {
  const base = clinicalBase.trim().replace(/\/+$/, "");
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

export const DICOM_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*';

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseMultipart(body: Uint8Array, contentType: string): { headers: Record<string, string>; bytes: Uint8Array }[] {
  const m = contentType.match(/boundary=("?)([^";]+)\1/i);
  if (!m) throw new Error(`no boundary in ${contentType}`);
  const enc = new TextEncoder();
  const delim = enc.encode(`--${m[2]}`);
  const parts: { headers: Record<string, string>; bytes: Uint8Array }[] = [];
  let pos = indexOf(body, delim, 0);
  if (pos < 0) throw new Error("multipart: opening boundary not found");
  while (true) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    pos += 2;
    const headEnd = indexOf(body, enc.encode("\r\n\r\n"), pos);
    const headers: Record<string, string> = {};
    for (const line of new TextDecoder().decode(body.subarray(pos, headEnd)).split("\r\n")) {
      const c = line.indexOf(":");
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    const start = headEnd + 4;
    let end: number;
    const cl = headers["content-length"];
    const e = start + Number(cl);
    if (cl !== undefined && body[e] === 0x0d && body[e + 1] === 0x0a && indexOf(body.subarray(e + 2, e + 2 + delim.length), delim, 0) === 0) {
      end = e;
    } else {
      end = indexOf(body, enc.encode(`\r\n--${m[2]}`), start);
      if (end < 0) throw new Error("multipart: closing boundary not found");
    }
    parts.push({ headers, bytes: body.subarray(start, end) });
    pos = end + 2;
  }
  return parts;
}

/** WADO-RS retrieve of a study or series: the Part 10 files, as sent. */
export async function wadoRetrieve(url: string, token: string): Promise<Uint8Array[]> {
  const res = await getWithRetry(url, { authorization: `Bearer ${token}`, accept: DICOM_ACCEPT });
  if (!res.ok) throw new Error(`WADO-RS ${res.status} for ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/related")) throw new Error(`WADO-RS answered ${ct}`);
  return parseMultipart(new Uint8Array(await res.arrayBuffer()), ct).map((p) => p.bytes);
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
