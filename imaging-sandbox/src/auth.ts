// Authorization Server: SMART App Launch 2.x standalone launch for public
// clients with PKCE (S256), a demo login and consent page, refresh tokens,
// RFC 7662 / SMART token introspection, and RFC 7009 revocation.
//
// Tokens are opaque random strings held in memory. The resource servers in
// this process validate them with validateAccessToken(); a separate
// Imaging Server would call the introspection endpoint instead.

import type { Config, ClientRegistration } from "./config.ts";
import type { Store, Study } from "./data.ts";
import { studiesForPatient } from "./data.ts";
import { grantableScope, describeScope } from "./scopes.ts";
import { page, esc } from "./pages.ts";

export interface Grant {
  id: string;
  clientId: string;
  patient: string;
  scopes: string[];
  studyUIDs: string[]; // studies the user chose to share
  aud: string[]; // every resource server base the token is valid at
  createdAt: number;
}

interface AccessToken { token: string; grant: Grant; iat: number; exp: number; revoked: boolean; }
interface RefreshToken { token: string; grant: Grant; exp: number; revoked: boolean; }
interface AuthCode { code: string; grant: Grant; redirectUri: string; challenge: string; exp: number; used: boolean; issued: string[]; }
interface PendingAuth {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  aud: string;
  requested: string[]; // requested scopes, as sent
  grantable: string[]; // what this server can grant
  challenge: string;
  exp: number;
}

export interface ValidatedToken {
  token: string;
  grant: Grant;
  exp: number;
}

function rand(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function sha256b64url(s: string): string {
  return Buffer.from(new Bun.CryptoHasher("sha256").update(s).digest()).toString("base64url");
}

const now = () => Math.floor(Date.now() / 1000);

function isLoopback(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export class AuthServer {
  accessTokens = new Map<string, AccessToken>();
  refreshTokens = new Map<string, RefreshToken>();
  codes = new Map<string, AuthCode>();
  pending = new Map<string, PendingAuth>();

  constructor(private cfg: Config, private store: Store) {
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  get base() { return `${this.cfg.baseUrl}/auth`; }
  get clinicalBase() { return `${this.cfg.baseUrl}/fhir`; }
  get imagingBase() { return `${this.cfg.baseUrl}/imaging/fhir`; }
  get wadoBase() { return `${this.cfg.baseUrl}/wado-rs`; }

  // Shared state of each grant (one consent), across its refreshed tokens.
  grants = new Map<string, { revoked: boolean; exp: number }>();

  grantActive(grantId: string): boolean {
    const g = this.grants.get(grantId);
    return !!g && !g.revoked && g.exp > now();
  }

  private revokeGrant(grantId: string) {
    const g = this.grants.get(grantId);
    if (g) g.revoked = true;
    for (const a of this.accessTokens.values()) if (a.grant.id === grantId) a.revoked = true;
    for (const r of this.refreshTokens.values()) if (r.grant.id === grantId) r.revoked = true;
  }

  private sweep() {
    const t = now();
    for (const [k, v] of this.accessTokens) if (v.exp < t - 3600) this.accessTokens.delete(k);
    for (const [k, v] of this.refreshTokens) if (v.exp < t) this.refreshTokens.delete(k);
    for (const [k, v] of this.codes) if (v.exp < t - 600) this.codes.delete(k);
    for (const [k, v] of this.pending) if (v.exp < t) this.pending.delete(k);
    // A grant is kept while a code, token or refresh token can still use it, and an hour after.
    const inUse = new Set([...this.codes.values()].map((c) => c.grant.id));
    for (const [k, v] of this.grants) if (v.exp < t - 3600 && !inUse.has(k)) this.grants.delete(k);
  }

  // ---------- client registration ----------

  private resolveClient(clientId: string, redirectUri: string): { client?: ClientRegistration; error?: string } {
    const reg = this.cfg.clients.find((c) => c.client_id === clientId);
    if (reg) {
      if (!reg.redirect_uris.includes(redirectUri)) return { error: `redirect_uri is not registered for client ${clientId}` };
      return { client: reg };
    }
    if (!this.cfg.openClients) return { error: `unknown client_id ${clientId}` };
    let u: URL;
    try { u = new URL(redirectUri); } catch { return { error: "redirect_uri is not an absolute URL" }; }
    if (u.hash) return { error: "redirect_uri must not contain a fragment" };
    if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) {
      return { client: { client_id: clientId, redirect_uris: [redirectUri] } };
    }
    return { error: "redirect_uri must use https (or http on localhost)" };
  }

  // ---------- /auth/authorize ----------

  async authorize(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let p: URLSearchParams = url.searchParams;
    if (req.method === "POST") p = new URLSearchParams(await req.text());
    const clientId = p.get("client_id") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    if (!clientId || !redirectUri) return this.errorPage("The app's request is missing client_id or redirect_uri.");
    const { client, error } = this.resolveClient(clientId, redirectUri);
    if (!client) return this.errorPage(`The app's request was refused: ${error}.`);

    const state = p.get("state") ?? "";
    const fail = (err: string, desc: string) => {
      const r = new URL(redirectUri);
      r.searchParams.set("error", err);
      r.searchParams.set("error_description", desc);
      if (state) r.searchParams.set("state", state);
      return redirect(r.toString());
    };
    if (p.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (!state) return fail("invalid_request", "state is required");
    if (p.get("launch")) return fail("invalid_request", "EHR launch is not supported; use a standalone launch");
    const aud = (p.get("aud") ?? "").replace(/\/+$/, "");
    if (aud !== this.clinicalBase && aud !== this.imagingBase) {
      return fail("invalid_request", `aud must be ${this.clinicalBase} or ${this.imagingBase}`);
    }
    const challenge = p.get("code_challenge") ?? "";
    if (!challenge) return fail("invalid_request", "PKCE code_challenge is required");
    if (p.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge must be a base64url SHA-256 value");

    const requested = (p.get("scope") ?? "").split(/\s+/).filter(Boolean);
    const grantable = [...new Set(requested.map(grantableScope).filter((s): s is string => !!s))];
    if (!grantable.some((s) => s.startsWith("patient/"))) {
      return fail("invalid_scope", "request at least one patient-level read scope, such as patient/ImagingStudy.rs");
    }

    const pending: PendingAuth = {
      id: rand(18),
      clientId,
      clientName: client.name ?? clientId,
      redirectUri,
      state,
      aud,
      requested,
      grantable,
      challenge,
      exp: now() + 1800,
    };
    this.pending.set(pending.id, pending);
    return this.loginPage(pending);
  }

  private loginPage(pa: PendingAuth): Response {
    const rows = [...this.store.patients.values()].map((pt, i) => {
      const n = studiesForPatient(this.store, pt.id).length;
      const detail = pt.synthetic ? "synthetic test patient, no imaging" : `${n} imaging ${n === 1 ? "study" : "studies"}`;
      return `<label class="choice"><input type="radio" name="patient" value="${esc(pt.id)}"${i === 0 ? " checked" : ""}>
        <span><strong>${esc(pt.given.join(" "))} ${esc(pt.family)}</strong><small>${esc(detail)}</small></span></label>`;
    });
    return page("Sign in", `
      <p class="lede">${esc(pa.clientName)} wants to connect to this sandbox patient portal.</p>
      <form method="post" action="${esc(this.base)}/login">
        <input type="hidden" name="request" value="${esc(pa.id)}">
        <fieldset><legend>Choose a demo patient</legend>${rows.join("")}</fieldset>
        <p class="note">This is a sandbox: there are no passwords.</p>
        <button type="submit" name="action" value="login" class="primary">Continue</button>
      </form>`);
  }

  async login(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const pa = this.pending.get(form.get("request") ?? "");
    if (!pa || pa.exp < now()) return this.errorPage("This sign-in request has expired. Go back to the app and start again.");
    const patient = this.store.patients.get(form.get("patient") ?? "");
    if (!patient) return this.errorPage("Unknown patient.");
    return this.consentPage(pa, patient.id);
  }

  private consentPage(pa: PendingAuth, patientId: string): Response {
    const pt = this.store.patients.get(patientId)!;
    const studies = studiesForPatient(this.store, patientId);
    const redirectHost = new URL(pa.redirectUri).host;
    const scopeRows = pa.grantable.map((s) => `<label class="choice"><input type="checkbox" name="scope" value="${esc(s)}" checked>
        <span>${esc(describeScope(s))}<small><code>${esc(s)}</code></small></span></label>`).join("");
    const dropped = pa.requested.filter((s) => !pa.grantable.includes(s) && !pa.grantable.includes(grantableScope(s) ?? ""));
    const studyRows = studies.map((st) => `<label class="choice"><input type="checkbox" name="study" value="${esc(st.uid)}" checked>
        <span><strong>${esc(studyTitle(st))}</strong><small>${esc(studyDetail(st))}</small></span></label>`).join("");
    return page("Allow access?", `
      <p class="lede"><strong>${esc(pa.clientName)}</strong> is asking for access to ${esc(pt.given.join(" "))} ${esc(pt.family)}'s records.
        If you allow it, you return to <strong>${esc(redirectHost)}</strong>.</p>
      <form method="post" action="${esc(this.base)}/consent">
        <input type="hidden" name="request" value="${esc(pa.id)}">
        <input type="hidden" name="patient" value="${esc(patientId)}">
        <fieldset><legend>Permissions</legend>${scopeRows}</fieldset>
        ${dropped.length ? `<p class="note">Not available here: ${dropped.map((s) => `<code>${esc(s)}</code>`).join(", ")}</p>` : ""}
        <fieldset><legend>Imaging studies to share</legend>${studyRows || `<p class="note">This patient has no imaging studies.</p>`}</fieldset>
        <div class="actions">
          <button type="submit" name="decision" value="deny">Deny</button>
          <button type="submit" name="decision" value="allow" class="primary">Allow</button>
        </div>
      </form>`);
  }

  async consent(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const pa = this.pending.get(form.get("request") ?? "");
    if (!pa || pa.exp < now()) return this.errorPage("This sign-in request has expired. Go back to the app and start again.");
    this.pending.delete(pa.id);
    const r = new URL(pa.redirectUri);
    r.searchParams.set("state", pa.state);
    if (form.get("decision") !== "allow") {
      r.searchParams.set("error", "access_denied");
      r.searchParams.set("error_description", "The user denied access");
      return redirect(r.toString());
    }
    const patientId = form.get("patient") ?? "";
    if (!this.store.patients.has(patientId)) return this.errorPage("Unknown patient.");
    const scopes = form.getAll("scope").filter((s) => pa.grantable.includes(s));
    const own = new Set(studiesForPatient(this.store, patientId).map((s) => s.uid));
    const studyUIDs = form.getAll("study").filter((u) => own.has(u));
    // The token is bound to all three resource servers of this deployment,
    // whichever FHIR base the app named as aud.
    const grant: Grant = { id: rand(12), clientId: pa.clientId, patient: patientId, scopes, studyUIDs, aud: [this.clinicalBase, this.imagingBase, this.wadoBase], createdAt: now() };
    this.grants.set(grant.id, { revoked: false, exp: 0 });
    const code = rand(32);
    this.codes.set(code, { code, grant, redirectUri: pa.redirectUri, challenge: pa.challenge, exp: now() + 60, used: false, issued: [] });
    r.searchParams.set("code", code);
    return redirect(r.toString());
  }

  // ---------- /auth/token ----------

  async token(req: Request): Promise<Response> {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/x-www-form-urlencoded")) return tokenError("invalid_request", "use application/x-www-form-urlencoded");
    const p = new URLSearchParams(await req.text());
    if (req.headers.get("authorization")) return tokenError("invalid_client", "this sandbox registers public clients only; send client_id in the body", 401);
    const gt = p.get("grant_type");
    const clientId = p.get("client_id") ?? "";
    if (!clientId) return tokenError("invalid_request", "client_id is required");

    if (gt === "authorization_code") {
      const ac = this.codes.get(p.get("code") ?? "");
      if (!ac || ac.exp < now()) return tokenError("invalid_grant", "unknown or expired code");
      if (ac.used) {
        // Code replay: revoke everything issued from it.
        this.revokeGrant(ac.grant.id);
        return tokenError("invalid_grant", "code already used");
      }
      if (ac.grant.clientId !== clientId) return tokenError("invalid_grant", "code was issued to another client");
      if (p.get("redirect_uri") !== ac.redirectUri) return tokenError("invalid_grant", "redirect_uri does not match");
      const verifier = p.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return tokenError("invalid_grant", "code_verifier is missing or malformed");
      if (sha256b64url(verifier) !== ac.challenge) return tokenError("invalid_grant", "PKCE verification failed");
      ac.used = true;
      const body = this.issue(ac.grant, true);
      ac.issued.push(body.access_token as string);
      if (body.refresh_token) ac.issued.push(body.refresh_token as string);
      return tokenJson(body);
    }

    if (gt === "refresh_token") {
      const rt = this.refreshTokens.get(p.get("refresh_token") ?? "");
      if (!rt || rt.revoked || rt.exp < now()) return tokenError("invalid_grant", "unknown, expired or revoked refresh token");
      if (rt.grant.clientId !== clientId) return tokenError("invalid_grant", "refresh token was issued to another client");
      let grant = rt.grant;
      const scope = p.get("scope");
      if (scope) {
        const want = scope.split(/\s+/).filter(Boolean);
        if (want.some((s) => !grant.scopes.includes(s))) return tokenError("invalid_scope", "a refresh can only narrow the granted scopes");
        grant = { ...grant, scopes: want };
      }
      return tokenJson(this.issue(grant, false, rt.token));
    }

    return tokenError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  private issue(grant: Grant, newRefresh: boolean, existingRefresh?: string): Record<string, unknown> {
    const access = rand(32);
    const iat = now();
    const exp = iat + this.cfg.accessTokenTtl;
    this.accessTokens.set(access, { token: access, grant, iat, exp, revoked: false });
    const state = this.grants.get(grant.id)!;
    state.exp = Math.max(state.exp, exp);
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.cfg.accessTokenTtl,
      scope: grant.scopes.join(" "),
      patient: grant.patient,
    };
    if (grant.scopes.includes("offline_access") || grant.scopes.includes("online_access")) {
      if (newRefresh) {
        const rt = rand(48);
        this.refreshTokens.set(rt, { token: rt, grant, exp: now() + this.cfg.refreshTokenTtl, revoked: false });
        state.exp = Math.max(state.exp, now() + this.cfg.refreshTokenTtl);
        body.refresh_token = rt;
      } else if (existingRefresh) {
        body.refresh_token = existingRefresh;
      }
    }
    return body;
  }

  // ---------- validation, introspection, revocation ----------

  // Validates a token for use at one resource server (its base URL).
  validateAccessToken(token: string, resourceBase: string): ValidatedToken | null {
    const at = this.accessTokens.get(token);
    if (!at || at.revoked || at.exp <= now() || !this.grantActive(at.grant.id)) return null;
    if (!at.grant.aud.includes(resourceBase)) return null;
    return { token, grant: at.grant, exp: at.exp };
  }

  introspectionBody(token: string): Record<string, unknown> {
    const at = this.accessTokens.get(token);
    if (!at || at.revoked || at.exp <= now() || !this.grantActive(at.grant.id)) return { active: false };
    return {
      active: true,
      token_type: "Bearer",
      scope: at.grant.scopes.join(" "),
      client_id: at.grant.clientId,
      exp: at.exp,
      iat: at.iat,
      iss: this.base,
      aud: at.grant.aud,
      patient: at.grant.patient,
      // Not a SMART field: the studies the user chose to share. A separate
      // Imaging Server would need this (or a policy lookup) to enforce
      // study-level restrictions; see authorization-patterns in the IG.
      imaging_study_uids: at.grant.studyUIDs,
    };
  }

  private callerIsResourceServer(req: Request): boolean {
    const h = req.headers.get("authorization") ?? "";
    const key = this.cfg.introspectionKey;
    if (h === `Bearer ${key}`) return true;
    if (h.startsWith("Basic ")) {
      const [, pass] = Buffer.from(h.slice(6), "base64").toString().split(":");
      return pass === key;
    }
    return false;
  }

  async introspect(req: Request): Promise<Response> {
    if (!this.callerIsResourceServer(req)) {
      return new Response(JSON.stringify({ error: "invalid_client", error_description: "introspection requires the resource-server key" }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="introspection"', "cache-control": "no-store" },
      });
    }
    const p = new URLSearchParams(await req.text());
    return tokenJson(this.introspectionBody(p.get("token") ?? ""));
  }

  async revoke(req: Request): Promise<Response> {
    const p = new URLSearchParams(await req.text());
    const t = p.get("token") ?? "";
    const clientId = p.get("client_id") ?? "";
    const at = this.accessTokens.get(t);
    if (at && at.grant.clientId === clientId) at.revoked = true;
    const rt = this.refreshTokens.get(t);
    if (rt && rt.grant.clientId === clientId) {
      this.revokeGrant(rt.grant.id);
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  private errorPage(msg: string): Response {
    return page("Can't continue", `<p class="lede">${esc(msg)}</p>`, 400);
  }
}

export function studyTitle(st: Study): string {
  return st.description ?? `${st.modalities.join("/")} study`;
}

export function studyDetail(st: Study): string {
  const n = st.series.reduce((a, s) => a + s.instances.length, 0);
  const parts = [st.modalities.join(", ")];
  if (st.started) parts.push(new Date(st.started.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }));
  parts.push(`${st.series.length} series`, `${n} images`, `${(st.bytes / 1e6).toFixed(0)} MB`);
  return parts.join(" · ");
}

function tokenJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
  });
}

function tokenError(error: string, description: string, status = 400): Response {
  return tokenJson({ error, error_description: description }, status);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
