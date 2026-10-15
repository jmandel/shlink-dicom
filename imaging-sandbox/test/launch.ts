// Runs a standalone launch by submitting the sandbox's login and consent
// forms over plain HTTP (no browser), for tests that need many tokens.

import * as C from "./client.ts";

export interface LaunchOptions {
  patient?: string;
  scope?: string;
  studies?: string[]; // Study Instance UIDs to share; default: all offered
  keepScopes?: string[]; // scopes left ticked; default: all offered
  clientId?: string;
  redirectUri?: string;
}

export interface Launch { d: C.Discovery; token: Record<string, any>; }

export async function launchViaForms(base: string, o: LaunchOptions): Promise<Launch> {
  const clientId = o.clientId ?? "imaging-sandbox-test";
  const redirectUri = o.redirectUri ?? "http://127.0.0.1:9/callback";
  const patient = o.patient ?? "josh-example";
  const d = await C.discover(`${base}/fhir`);
  const { verifier, challenge } = await C.pkce();
  const state = crypto.randomUUID();
  let r = await fetch(C.authorizeUrl(d, { clientId, redirectUri, scope: o.scope ?? "launch/patient patient/*.rs", state, challenge }), { redirect: "manual" });
  const loginHtml = await r.text();
  const request = loginHtml.match(/name="request" value="([^"]+)"/)?.[1];
  if (!request) throw new Error(`no login form (HTTP ${r.status}, location ${r.headers.get("location")})`);
  const form = { "content-type": "application/x-www-form-urlencoded" };
  r = await fetch(`${base}/auth/login`, { method: "POST", headers: form, body: new URLSearchParams({ request, patient }) });
  const consentHtml = await r.text();
  const scopes = [...consentHtml.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]);
  const studies = [...consentHtml.matchAll(/name="study" value="([^"]+)"/g)].map((m) => m[1]);
  const body = new URLSearchParams({ request, patient, decision: "allow" });
  for (const s of o.keepScopes ?? scopes) body.append("scope", s);
  for (const s of o.studies ?? studies) body.append("study", s);
  r = await fetch(`${base}/auth/consent`, { method: "POST", headers: form, body, redirect: "manual" });
  const loc = new URL(r.headers.get("location") ?? "");
  if (loc.searchParams.get("state") !== state) throw new Error("state mismatch");
  const code = loc.searchParams.get("code");
  if (!code) throw new Error(`no code: ${loc}`);
  return { d, token: await C.exchangeCode(d, { code, verifier, clientId, redirectUri }) };
}
