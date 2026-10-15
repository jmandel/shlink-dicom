// A minimal SMART Imaging Access client using only fetch and WebCrypto, so
// it runs unchanged in a browser and in Bun. The e2e test bundles it into
// a page at another origin to prove the browser flow (including CORS).
//
// It follows the IG's steps: discover the imaging endpoint, run a
// standalone launch with PKCE, search ImagingStudy with
// _include=ImagingStudy:endpoint, resolve each study's Endpoint (contained,
// included, or response-local urn:uuid), and retrieve over WADO-RS with the
// same token.

export const APP_LAUNCH = "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch";

export interface Discovery {
  smart: Record<string, any>;
  clinicalBase: string;
  imagingBase: string;
}

export async function discover(clinicalBase: string): Promise<Discovery> {
  const base = clinicalBase.replace(/\/+$/, "");
  const res = await fetch(`${base}/.well-known/smart-configuration`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`smart-configuration: HTTP ${res.status}`);
  const smart = await res.json();
  const has = (caps: unknown) => Array.isArray(caps) && caps.includes("smart-imaging-access") && caps.includes(APP_LAUNCH);
  let imagingBase: string | undefined;
  if (has(smart.capabilities)) imagingBase = base;
  for (const ae of smart.associated_endpoints ?? []) if (!imagingBase && has(ae.capabilities)) imagingBase = String(ae.url).replace(/\/+$/, "");
  if (!imagingBase) throw new Error("no imaging endpoint advertising smart-imaging-access with App Launch");
  if (!smart.grant_types_supported?.includes("authorization_code")) throw new Error("authorization_code grant not advertised");
  if (!smart.code_challenge_methods_supported?.includes("S256")) throw new Error("S256 PKCE not advertised");
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

export function authorizeUrl(d: Discovery, o: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const u = new URL(d.smart.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("aud", d.clinicalBase);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function tokenRequest(d: Discovery, params: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(d.smart.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(`token: ${body.error}: ${body.error_description}`), { status: res.status, body });
  return body;
}

export function exchangeCode(d: Discovery, o: { code: string; verifier: string; clientId: string; redirectUri: string }) {
  return tokenRequest(d, { grant_type: "authorization_code", code: o.code, code_verifier: o.verifier, client_id: o.clientId, redirect_uri: o.redirectUri });
}

export function refresh(d: Discovery, o: { refreshToken: string; clientId: string }) {
  return tokenRequest(d, { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId });
}

// GET with the IG's delayed-results pattern: on 503 with Retry-After, wait
// and repeat the identical request (up to a few times).
export async function getWithRetry(url: string, headers: Record<string, string>, tries = 4): Promise<Response> {
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
  if (!res.ok) throw Object.assign(new Error(`GET ${url}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// ---------- Endpoint resolution (FHIR Bundle reference rules) ----------

export interface FoundStudy {
  study: any;
  studyUID: string;
  wadoBase: string;
}

function resolveInBundle(bundle: any, entry: any, ref: string): any | undefined {
  const byFullUrl = (u: string) => bundle.entry?.find((e: any) => e.fullUrl === u)?.resource;
  if (ref.startsWith("#")) return entry.resource.contained?.find((c: any) => `#${c.id}` === ref);
  if (/^urn:(uuid|oid):/.test(ref)) return byFullUrl(ref);
  if (/^https?:\/\//.test(ref)) return byFullUrl(ref);
  // Relative reference: resolve against the referencing entry's fullUrl base.
  const m = String(entry.fullUrl ?? "").match(/^(.*\/)[A-Za-z]+\/[^/]+$/);
  if (m) {
    const hit = byFullUrl(m[1] + ref);
    if (hit) return hit;
  }
  const [type, id] = ref.split("/");
  return bundle.entry?.find((e: any) => e.resource?.resourceType === type && e.resource?.id === id)?.resource;
}

export function studiesFromBundle(bundle: any): FoundStudy[] {
  const out: FoundStudy[] = [];
  for (const entry of bundle.entry ?? []) {
    const st = entry.resource;
    if (st?.resourceType !== "ImagingStudy" || entry.search?.mode === "include") continue;
    const uidValue = st.identifier?.find((i: any) => i.system === "urn:dicom:uid")?.value as string | undefined;
    if (!uidValue?.startsWith("urn:oid:")) throw new Error(`ImagingStudy/${st.id} has no urn:dicom:uid identifier`);
    let wadoBase: string | undefined;
    for (const ref of st.endpoint ?? []) {
      const ep = resolveInBundle(bundle, entry, ref.reference);
      if (ep?.resourceType === "Endpoint" && ep.connectionType?.code === "dicom-wado-rs" && ep.status === "active") {
        wadoBase = String(ep.address).replace(/\/+$/, "");
        break;
      }
    }
    if (!wadoBase) throw new Error(`ImagingStudy/${st.id}: could not resolve a WADO-RS Endpoint`);
    out.push({ study: st, studyUID: uidValue.slice("urn:oid:".length), wadoBase });
  }
  return out;
}

export async function searchStudies(imagingBase: string, patient: string, token: string, extra = ""): Promise<{ bundle: any; studies: FoundStudy[] }> {
  const bundle = await fhirGet(`${imagingBase}/ImagingStudy?patient=${encodeURIComponent(patient)}&_include=ImagingStudy:endpoint${extra}`, token);
  return { bundle, studies: studiesFromBundle(bundle) };
}

// ---------- WADO-RS ----------

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
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing --
    pos += 2; // CRLF
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

export async function wadoGet(url: string, token: string, accept = DICOM_ACCEPT): Promise<{ status: number; parts?: { headers: Record<string, string>; bytes: Uint8Array }[]; json?: any }> {
  const res = await getWithRetry(url, { authorization: `Bearer ${token}`, accept });
  if (!res.ok) { await res.arrayBuffer(); return { status: res.status }; }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.startsWith("multipart/related")) return { status: res.status, parts: parseMultipart(new Uint8Array(await res.arrayBuffer()), ct) };
  return { status: res.status, json: await res.json() };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
