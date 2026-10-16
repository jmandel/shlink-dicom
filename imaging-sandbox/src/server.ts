// Imaging sandbox: SMART Imaging Access actors in one Bun process.
//
//   /auth/...                 Authorization Server
//   /fhir/...                 Clinical FHIR Server (Patient, DiagnosticReport)
//   /imaging/fhir/...         Imaging FHIR Server (ImagingStudy, Endpoint)
//   /wado-rs/...              DICOMweb WADO-RS server
//
// Run: bun src/server.ts   (configuration: README.md)

import { loadConfig, type Config } from "./config.ts";
import { loadStore, studiesForPatient, type Store } from "./data.ts";
import { AuthServer, studyTitle, studyDetail } from "./auth.ts";
import { CapabilityStore, handleWado } from "./wado.ts";
import {
  fhirJson, outcome, unauthorized, smartConfiguration, clinicalCapabilityStatement, imagingCapabilityStatement,
  handleClinical, handleImaging, urls,
} from "./fhir.ts";
import { page, esc } from "./pages.ts";

export interface Sandbox {
  server: ReturnType<typeof Bun.serve>;
  cfg: Config;
  store: Store;
  auth: AuthServer;
}

function corsHeaders(cfg: Config, req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const h: Record<string, string> = {
    "access-control-expose-headers": "Content-Type, Content-Length, Content-Location, Content-Disposition, Location, Retry-After, WWW-Authenticate",
  };
  if (cfg.allowedOrigins === "*") h["access-control-allow-origin"] = "*";
  else if (cfg.allowedOrigins.includes(origin)) { h["access-control-allow-origin"] = origin; h["vary"] = "Origin"; }
  else return { vary: "Origin" };
  return h;
}

function preflight(cfg: Config, req: Request): Response {
  const h = corsHeaders(cfg, req);
  if (!h["access-control-allow-origin"]) return new Response(null, { status: 403, headers: h });
  return new Response(null, {
    status: 204,
    headers: {
      ...h,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Accept, Prefer",
      "access-control-max-age": "600",
    },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

function indexPage(cfg: Config, store: Store): Response {
  const u = urls(cfg);
  const pts = [...store.patients.values()].map((p) => {
    const st = studiesForPatient(store, p.id);
    return `<li><strong>${esc(p.given.join(" "))} ${esc(p.family)}</strong> (<code>Patient/${esc(p.id)}</code>)${p.synthetic ? " · synthetic, no imaging" : ""}
      ${st.length ? `<ul>${st.map((s) => `<li>${esc(studyTitle(s))}: ${esc(studyDetail(s))}<br><small><code>${esc(s.uid)}</code></small></li>`).join("")}</ul>` : ""}</li>`;
  }).join("");
  return page("Imaging sandbox", `
    <p class="lede">A SMART Imaging Access sandbox: one SMART authorization server, a clinical FHIR server, an imaging FHIR server and a WADO-RS server, all accepting the same access token.</p>
    <fieldset><legend>Endpoints</legend>
      <p>Clinical FHIR base: <code>${esc(u.clinical)}</code><br>
      Discovery: <code>${esc(u.clinical)}/.well-known/smart-configuration</code><br>
      Imaging FHIR base: <code>${esc(u.imaging)}</code><br>
      WADO-RS base: <code>${esc(u.wado)}</code><br>
      Endpoint form in search results: <code>${esc(cfg.endpointMode)}</code></p>
    </fieldset>
    <fieldset><legend>Demo patients</legend><ul>${pts}</ul></fieldset>`);
}

export async function startSandbox(env: Record<string, string | undefined> = process.env): Promise<Sandbox> {
  const cfg = loadConfig(env);
  const store = await loadStore(cfg.datasetDir, cfg.testPatientsFile, cfg.variantsDir);
  const auth = new AuthServer(cfg, store);
  const caps = new CapabilityStore(cfg);
  const basePath = new URL(cfg.baseUrl).pathname.replace(/\/+$/, "");

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (basePath && pathname.startsWith(basePath)) pathname = pathname.slice(basePath.length) || "/";
    const seg = pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "OPTIONS") return preflight(cfg, req);
    if (seg.length === 0) return indexPage(cfg, store);
    if (seg[0] === "healthz") return new Response("ok");

    // Authorization Server
    if (seg[0] === "auth") {
      switch (seg[1]) {
        case "authorize": return auth.authorize(req);
        case "login": return req.method === "POST" ? auth.login(req) : new Response("Method not allowed", { status: 405 });
        case "consent": return req.method === "POST" ? auth.consent(req) : new Response("Method not allowed", { status: 405 });
        case "token": return req.method === "POST" ? auth.token(req) : new Response("Method not allowed", { status: 405 });
        case "introspect": return req.method === "POST" ? auth.introspect(req) : new Response("Method not allowed", { status: 405 });
        case "revoke": return req.method === "POST" ? auth.revoke(req) : new Response("Method not allowed", { status: 405 });
      }
      return new Response("Not found", { status: 404 });
    }

    // FHIR bases: /fhir/... and /imaging/fhir/...
    let which: "clinical" | "imaging" | null = null;
    let rest: string[] = [];
    if (seg[0] === "fhir") { which = "clinical"; rest = seg.slice(1); }
    else if (seg[0] === "imaging" && seg[1] === "fhir") { which = "imaging"; rest = seg.slice(2); }

    if (which) {
      if (rest[0] === ".well-known" && rest[1] === "smart-configuration") {
        return Response.json(smartConfiguration(cfg, which), { headers: { "cache-control": "no-cache" } });
      }
      if (rest[0] === "metadata") return fhirJson(which === "clinical" ? clinicalCapabilityStatement(cfg) : imagingCapabilityStatement(cfg));
      if (rest.length === 0) return outcome(404, "not-found", "Specify a resource type");
      const t = bearer(req);
      if (!t) return unauthorized();
      const tok = auth.validateAccessToken(t, which === "clinical" ? `${cfg.baseUrl}/fhir` : `${cfg.baseUrl}/imaging/fhir`);
      if (!tok) return unauthorized("The access token is invalid, expired or revoked");
      return which === "clinical" ? handleClinical(cfg, store, tok, req, rest) : handleImaging(cfg, store, caps, tok, req, rest);
    }

    // WADO-RS: /wado-rs/studies/... and /wado-rs/cap/{id}/studies/...
    if (seg[0] === "wado-rs") {
      const t = bearer(req);
      const www = { "content-type": "application/json", "www-authenticate": 'Bearer realm="imaging-sandbox"' };
      if (!t) return new Response(JSON.stringify({ error: "a Bearer access token is required" }), { status: 401, headers: www });
      const tok = auth.validateAccessToken(t, `${cfg.baseUrl}/wado-rs`);
      if (!tok) {
        return new Response(JSON.stringify({ error: "the access token is invalid, expired or revoked" }), {
          status: 401,
          headers: { ...www, "www-authenticate": 'Bearer realm="imaging-sandbox", error="invalid_token"' },
        });
      }
      if (seg[1] === "cap") return handleWado(cfg, store, caps, auth, tok, req, seg.slice(3), seg[2]);
      return handleWado(cfg, store, caps, auth, tok, req, seg.slice(1));
    }

    return new Response("Not found", { status: 404 });
  }

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.hostname,
    idleTimeout: 120,
    async fetch(req) {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await route(req);
      } catch (e) {
        console.error(e);
        res = outcome(500, "exception", "Internal error");
      }
      for (const [k, v] of Object.entries(corsHeaders(cfg, req))) res.headers.set(k, v);
      if (cfg.logRequests) {
        // Log the path only (query strings can carry codes and state), and
        // redact capability identifiers, which are credentials.
        const path = new URL(req.url).pathname.replace(/\/cap\/[^/]+/, "/cap/[redacted]");
        console.log(`${req.method} ${path} ${res.status} ${(performance.now() - t0).toFixed(0)}ms`);
      }
      return res;
    },
  });
  return { server, cfg, store, auth };
}

if (import.meta.main) {
  const sb = await startSandbox();
  const u = urls(sb.cfg);
  const n = [...sb.store.studies.values()].reduce((a, s) => a + s.series.reduce((b, x) => b + x.instances.length, 0), 0);
  console.log(`imaging sandbox listening on ${sb.cfg.hostname}:${sb.server.port}`);
  console.log(`  base URL         ${u.base}`);
  console.log(`  clinical FHIR    ${u.clinical}`);
  console.log(`  imaging FHIR     ${u.imaging}  (Endpoint form: ${sb.cfg.endpointMode})`);
  console.log(`  WADO-RS          ${u.wado}`);
  console.log(`  studies          ${sb.store.studies.size} (${n} instances)`);
  console.log(`  allowed origins  ${sb.cfg.allowedOrigins === "*" ? "*" : sb.cfg.allowedOrigins.join(", ")}`);
  if (!process.env.INTROSPECTION_KEY) console.log(`  introspection key (generated; set INTROSPECTION_KEY to fix it): ${sb.cfg.introspectionKey}`);
}
