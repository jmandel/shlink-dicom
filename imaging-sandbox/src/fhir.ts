// Clinical FHIR server (Patient, DiagnosticReport) and Imaging FHIR server
// (ImagingStudy, Endpoint), plus discovery documents.

import type { Config } from "./config.ts";
import type { Store, Study, DemoPatient } from "./data.ts";
import { studiesForPatient, DATA_LAST_UPDATED } from "./data.ts";
import type { ValidatedToken } from "./auth.ts";
import { scopeAllows, type Perm } from "./scopes.ts";
import type { CapabilityStore } from "./wado.ts";

export const IG = "http://fhir.org/argonaut/smart-imaging";
export const PROFILE_STUDY = `${IG}/StructureDefinition/smart-imaging-study`;
export const PROFILE_ENDPOINT = `${IG}/StructureDefinition/smart-wado-endpoint`;
const DCM = "http://dicom.nema.org/resources/ontology/DCM";

const MODALITY: Record<string, string> = {
  CR: "Computed Radiography", CT: "Computed Tomography", DX: "Digital Radiography", MG: "Mammography",
  MR: "Magnetic Resonance", NM: "Nuclear Medicine", OT: "Other", PT: "Positron emission tomography",
  US: "Ultrasound", XA: "X-Ray Angiography", SR: "SR Document", SC: "Secondary Capture", SM: "Slide Microscopy",
};

export interface Urls {
  base: string;
  clinical: string;
  imaging: string;
  wado: string;
  auth: string;
}

export function urls(cfg: Config): Urls {
  return {
    base: cfg.baseUrl,
    clinical: `${cfg.baseUrl}/fhir`,
    imaging: `${cfg.baseUrl}/imaging/fhir`,
    wado: `${cfg.baseUrl}/wado-rs`,
    auth: `${cfg.baseUrl}/auth`,
  };
}

// ---------- responses ----------

export function fhirJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/fhir+json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function outcome(status: number, code: string, diagnostics: string, extra: Record<string, string> = {}): Response {
  return fhirJson({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] }, status, extra);
}

export function unauthorized(reason?: string): Response {
  const hdr = reason ? `Bearer realm="imaging-sandbox", error="invalid_token", error_description="${reason}"` : 'Bearer realm="imaging-sandbox"';
  return outcome(401, "login", reason ?? "A Bearer access token is required", { "www-authenticate": hdr });
}

export function insufficientScope(need: string): Response {
  return outcome(403, "forbidden", `The token's scopes do not allow this request (needs ${need})`, {
    "www-authenticate": `Bearer realm="imaging-sandbox", error="insufficient_scope", scope="${need}"`,
  });
}

// ---------- discovery ----------

export function smartConfiguration(cfg: Config, which: "clinical" | "imaging"): Record<string, unknown> {
  const u = urls(cfg);
  const imagingCaps = ["smart-imaging-access", `${IG}/capabilities/app-launch`];
  const caps = [
    "launch-standalone",
    "client-public",
    "context-standalone-patient",
    "permission-patient",
    "permission-v1",
    "permission-v2",
    "permission-offline",
    "permission-online",
    "authorize-post",
  ];
  const doc: Record<string, unknown> = {
    authorization_endpoint: `${u.auth}/authorize`,
    token_endpoint: `${u.auth}/token`,
    token_endpoint_auth_methods_supported: ["none"],
    introspection_endpoint: `${u.auth}/introspect`,
    revocation_endpoint: `${u.auth}/revoke`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [
      "launch/patient",
      "offline_access",
      "online_access",
      "patient/ImagingStudy.rs",
      "patient/Patient.rs",
      "patient/DiagnosticReport.rs",
      "patient/*.rs",
      "patient/ImagingStudy.read",
      "patient/Patient.read",
      "patient/DiagnosticReport.read",
      "patient/*.read",
    ],
    capabilities: which === "imaging" ? [...caps, ...imagingCaps] : caps,
  };
  if (which === "clinical") doc.associated_endpoints = [{ url: u.imaging, capabilities: imagingCaps }];
  return doc;
}

export function clinicalCapabilityStatement(cfg: Config): Record<string, unknown> {
  const u = urls(cfg);
  return {
    resourceType: "CapabilityStatement",
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Imaging sandbox clinical FHIR server: Patient and DiagnosticReport, read and search, and Binary report attachments; SMART App Launch.</div>` },
    status: "active",
    date: "2026-10-15",
    kind: "instance",
    implementation: { description: "Imaging sandbox: clinical FHIR server", url: u.clinical },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        security: {
          service: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "SMART-on-FHIR" }] }],
          description: `SMART App Launch; see ${u.clinical}/.well-known/smart-configuration`,
        },
        resource: [
          { type: "Patient", interaction: [{ code: "read" }, { code: "search-type" }], searchParam: [{ name: "_id", type: "token" }] },
          {
            type: "DiagnosticReport",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference" },
              { name: "category", type: "token" },
              { name: "code", type: "token" },
              { name: "_id", type: "token" },
            ],
          },
          { type: "Binary", interaction: [{ code: "read" }] },
        ],
      },
    ],
  };
}

export function imagingCapabilityStatement(cfg: Config): Record<string, unknown> {
  const u = urls(cfg);
  return {
    resourceType: "CapabilityStatement",
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Imaging sandbox imaging FHIR server: ImagingStudy search by patient, identifier and _lastUpdated, with _include=ImagingStudy:endpoint.</div>` },
    status: "active",
    date: "2026-10-15",
    kind: "instance",
    instantiates: [`${IG}/CapabilityStatement/smart-imaging-server`],
    implementation: { description: "Imaging sandbox: imaging FHIR server", url: u.imaging },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        security: {
          service: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "SMART-on-FHIR" }] }],
          description: `SMART App Launch; see ${u.imaging}/.well-known/smart-configuration`,
        },
        resource: [
          {
            type: "ImagingStudy",
            supportedProfile: [PROFILE_STUDY],
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchInclude: ["ImagingStudy:endpoint"],
            searchParam: [
              { name: "patient", type: "reference" },
              { name: "identifier", type: "token" },
              { name: "_lastUpdated", type: "date" },
            ],
          },
          ...(cfg.endpointMode === "external" ? [{ type: "Endpoint", supportedProfile: [PROFILE_ENDPOINT], interaction: [{ code: "read" }] }] : []),
        ],
      },
    ],
  };
}

// ---------- resource builders ----------

function escXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function patientName(p: DemoPatient): string {
  return `${p.given.join(" ")} ${p.family}`;
}

// Identifier systems are URLs under the deployment's own base: the
// sandbox plays the health system that assigns MRNs and accession numbers.
function accessionIdentifier(cfg: Config, st: Study) {
  return {
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN", display: "Accession ID" }] },
    system: `${cfg.baseUrl}/identifiers/accession`,
    value: st.accession,
  };
}

export function patientResource(cfg: Config, p: DemoPatient): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Patient",
    id: p.id,
    meta: { lastUpdated: DATA_LAST_UPDATED },
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${escXml(patientName(p))}${p.birthDate ? `, born ${p.birthDate}` : ""}${p.synthetic ? " (synthetic test patient)" : " (fictional sample patient)"}</div>`,
    },
  };
  if (p.mrn) {
    r.identifier = [{
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }] },
      system: `${cfg.baseUrl}/identifiers/mrn`,
      value: p.mrn,
    }];
  }
  r.name = [{ text: patientName(p), family: p.family, given: p.given }];
  if (p.birthDate) r.birthDate = p.birthDate;
  return r;
}

function seriesCount(st: Study) {
  return st.series.reduce((a, s) => a + s.instances.length, 0);
}

export function binaryUrl(cfg: Config, id: string): string {
  return `${urls(cfg).clinical}/Binary/${id}`;
}

export function diagnosticReport(cfg: Config, st: Study): Record<string, unknown> {
  const u = urls(cfg);
  const rep = st.report;
  const r: Record<string, unknown> = {
    resourceType: "DiagnosticReport",
    id: rep.id,
    meta: { lastUpdated: st.lastUpdated },
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p><b>${escXml(rep.title)}</b>, ${escXml(st.started ?? "")}, accession ${escXml(st.accession)}</p><p>${escXml(rep.conclusion)}</p></div>`,
    },
    identifier: [accessionIdentifier(cfg, st)],
    status: "final",
    category: [{ coding: [rep.category] }],
    code: { coding: [rep.code], text: rep.title },
    subject: { reference: `Patient/${st.patientId}` },
  };
  if (st.started) r.effectiveDateTime = st.started;
  Object.assign(r, {
    imagingStudy: [
      {
        reference: `${u.imaging}/ImagingStudy/${st.id}`,
        identifier: { system: "urn:dicom:uid", value: `urn:oid:${st.uid}` },
      },
    ],
    conclusion: rep.conclusion,
    presentedForm: rep.attachments.map((a) => ({
      contentType: a.contentType,
      language: "en",
      url: binaryUrl(cfg, a.id),
      size: a.size,
      hash: a.sha1,
      title: a.title,
    })),
  });
  return r;
}

export function wadoEndpoint(cfg: Config, id: string, address: string): Record<string, unknown> {
  return {
    resourceType: "Endpoint",
    id,
    meta: { profile: [PROFILE_ENDPOINT] },
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">WADO-RS base URL: ${escXml(address)}</div>` },
    status: "active",
    connectionType: { system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type", code: "dicom-wado-rs" },
    name: "Imaging sandbox WADO-RS",
    payloadType: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/endpoint-payload-type", code: "any" }] }],
    address,
  };
}

export function imagingStudy(cfg: Config, st: Study, endpointRef: string, contained?: Record<string, unknown>): Record<string, unknown> {
  const u = urls(cfg);
  const r: Record<string, unknown> = {
    resourceType: "ImagingStudy",
    id: st.id,
    meta: { lastUpdated: st.lastUpdated, profile: [PROFILE_STUDY] },
  };
  const n = seriesCount(st);
  r.text = {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml">${escXml(st.description ?? "Imaging study")} (${st.modalities.join(", ")})${st.started ? `, ${st.started}` : ""}: ${st.series.length} series, ${n} instances. Study Instance UID ${st.uid}.</div>`,
  };
  if (contained) r.contained = [contained];
  Object.assign(r, {
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${st.uid}` }, accessionIdentifier(cfg, st)],
    status: "available",
    modality: st.modalities.map((m) => ({ system: DCM, code: m, display: MODALITY[m] ?? m })),
    subject: { reference: `${u.clinical}/Patient/${st.patientId}` },
  });
  if (st.started) r.started = st.started;
  Object.assign(r, {
    endpoint: [{ reference: endpointRef }],
    numberOfSeries: st.series.length,
    numberOfInstances: seriesCount(st),
  });
  if (st.description) r.description = st.description;
  if (st.attribution) r.note = [{ text: st.attribution }];
  r.series = st.series.map((s) => {
    const out: Record<string, unknown> = { uid: s.uid };
    if (s.number !== undefined) out.number = s.number;
    out.modality = { system: DCM, code: s.modality, display: MODALITY[s.modality] ?? s.modality };
    if (s.description) out.description = s.description;
    out.numberOfInstances = s.instances.length;
    out.instance = s.instances.map((i) => {
      const inst: Record<string, unknown> = { uid: i.sopInstanceUID, sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${i.sopClassUID}` } };
      if (i.number !== undefined) inst.number = i.number;
      return inst;
    });
    return out;
  });
  return r;
}

// ---------- request handling helpers ----------

function need(tok: ValidatedToken, resource: string, perm: Perm): Response | null {
  if (scopeAllows(tok.grant.scopes, resource, perm)) return null;
  return insufficientScope(`patient/${resource}.${perm}`);
}

// Accepts "123", "Patient/123", or "<clinical base>/Patient/123".
function patientParam(cfg: Config, v: string): string | null {
  const u = urls(cfg);
  if (v.startsWith(`${u.clinical}/Patient/`)) return v.slice(u.clinical.length + 9);
  if (v.startsWith("Patient/")) return v.slice(8);
  if (/^[A-Za-z0-9\-.]{1,64}$/.test(v)) return v;
  return null;
}

function visibleStudies(store: Store, tok: ValidatedToken): Study[] {
  return studiesForPatient(store, tok.grant.patient).filter((s) => tok.grant.studyUIDs.includes(s.uid));
}

function lastUpdatedMatches(lastUpdated: string, param: string): boolean {
  const m = param.match(/^(eq|ne|gt|lt|ge|le|sa|eb|ap)?(.+)$/);
  if (!m) return false;
  const prefix = m[1] ?? "eq";
  const v = m[2];
  const start = Date.parse(v.length === 4 ? `${v}-01-01T00:00:00Z` : v.length === 7 ? `${v}-01T00:00:00Z` : v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(start)) return false;
  const span = v.length === 4 ? "year" : v.length === 7 ? "month" : v.length === 10 ? "day" : "instant";
  const endD = new Date(start);
  if (span === "year") endD.setUTCFullYear(endD.getUTCFullYear() + 1);
  else if (span === "month") endD.setUTCMonth(endD.getUTCMonth() + 1);
  else if (span === "day") endD.setUTCDate(endD.getUTCDate() + 1);
  else endD.setTime(start + (/\.\d+/.test(v) ? 1 : 1000));
  const end = endD.getTime();
  const t = Date.parse(lastUpdated);
  switch (prefix) {
    case "eq": case "ap": return t >= start && t < end;
    case "ne": return t < start || t >= end;
    case "gt": case "sa": return t >= end;
    case "ge": return t >= start;
    case "lt": case "eb": return t < start;
    case "le": return t < end;
  }
  return false;
}

function identifierMatches(st: Study, param: string): boolean {
  return param.split(",").some((tok) => {
    let system: string | undefined;
    let value = tok;
    const bar = tok.indexOf("|");
    if (bar >= 0) { system = tok.slice(0, bar); value = tok.slice(bar + 1); }
    if (system && system !== "urn:dicom:uid") return false;
    return value === `urn:oid:${st.uid}`;
  });
}

// ---------- clinical server ----------

export function handleClinical(cfg: Config, store: Store, tok: ValidatedToken, req: Request, path: string[]): Response {
  const url = new URL(req.url);
  const [type, id] = path;
  if (req.method !== "GET") return outcome(405, "not-supported", "This server is read-only");

  if (type === "Patient") {
    if (id) {
      const denied = need(tok, "Patient", "r");
      if (denied) return denied;
      if (id !== tok.grant.patient) return outcome(403, "forbidden", "The token's patient context does not match this Patient");
      return fhirJson(patientResource(cfg, store.patients.get(id)!));
    }
    const denied = need(tok, "Patient", "s");
    if (denied) return denied;
    const ids = url.searchParams.get("_id")?.split(",") ?? [tok.grant.patient];
    if (ids.some((i) => i !== tok.grant.patient)) return outcome(403, "forbidden", "The token's patient context does not match the requested patient");
    const p = store.patients.get(tok.grant.patient)!;
    return fhirJson(searchset(`${urls(cfg).clinical}/Patient?_id=${p.id}`, [{ fullUrl: `${urls(cfg).clinical}/Patient/${p.id}`, resource: patientResource(cfg, p), search: { mode: "match" } }], 1));
  }

  if (type === "DiagnosticReport") {
    const u = urls(cfg);
    let reports = visibleStudies(store, tok).map((st) => diagnosticReport(cfg, st));
    if (id) {
      const denied = need(tok, "DiagnosticReport", "r");
      if (denied) return denied;
      const r = reports.find((x) => x.id === id);
      return r ? fhirJson(r) : outcome(404, "not-found", `DiagnosticReport/${id} not found`);
    }
    const denied = need(tok, "DiagnosticReport", "s");
    if (denied) return denied;
    const sp = url.searchParams;
    const pv = sp.get("patient") ?? sp.get("subject");
    const pid = pv ? patientParam(cfg, pv) : null;
    if (!pid) return outcome(400, "required", "Search by patient");
    if (pid !== tok.grant.patient) return outcome(403, "forbidden", "The token's patient context does not match the patient parameter");
    const self = new URL(`${u.clinical}/DiagnosticReport`);
    self.searchParams.set("patient", pid);
    for (const name of ["category", "code"] as const) {
      for (const v of sp.getAll(name)) {
        self.searchParams.append(name, v);
        reports = reports.filter((r) => {
          const cc = (name === "category" ? (r.category as any[]) : [r.code as any]).flatMap((c: any) => c.coding ?? []);
          return tokenMatches(cc, v);
        });
      }
    }
    for (const v of sp.getAll("_id")) {
      self.searchParams.append("_id", v);
      reports = reports.filter((r) => v.split(",").includes(r.id as string));
    }
    return fhirJson(searchset(self.toString(), reports.map((r) => ({ fullUrl: `${u.clinical}/DiagnosticReport/${r.id}`, resource: r, search: { mode: "match" } })), reports.length));
  }

  if (type === "Binary" && id) {
    // Report attachments. Access follows the report: a token that may read
    // the DiagnosticReport (or holds a Binary read scope) and covers its study.
    if (!scopeAllows(tok.grant.scopes, "DiagnosticReport", "r") && !scopeAllows(tok.grant.scopes, "Binary", "r")) return insufficientScope("patient/DiagnosticReport.r");
    const b = store.binaries.get(id);
    if (!b || b.study.patientId !== tok.grant.patient || !tok.grant.studyUIDs.includes(b.study.uid)) return outcome(404, "not-found", `Binary/${id} not found`);
    const accept = req.headers.get("accept") ?? "";
    if (/application\/(fhir\+)?json/.test(accept) && !accept.includes(b.attachment.contentType.split(";")[0])) {
      return fhirJson({ resourceType: "Binary", id, contentType: b.attachment.contentType, data: Buffer.from(b.attachment.bytes).toString("base64") });
    }
    const ext = b.attachment.contentType.startsWith("application/pdf") ? "pdf" : "txt";
    return new Response(b.attachment.bytes, {
      headers: {
        "content-type": b.attachment.contentType,
        "content-disposition": `inline; filename="${b.study.report.id}.${ext}"`,
        "cache-control": "no-store",
      },
    });
  }

  return outcome(404, "not-supported", `Resource type ${type} is not served here`);
}

// FHIR token search: "code", "system|code", "|code" or "system|", comma = OR.
function tokenMatches(codings: { system?: string; code?: string }[], param: string): boolean {
  return param.split(",").some((t) => {
    const bar = t.indexOf("|");
    if (bar < 0) return codings.some((c) => c.code === t);
    const sys = t.slice(0, bar), code = t.slice(bar + 1);
    return codings.some((c) => (sys === "" ? !c.system : c.system === sys) && (code === "" || c.code === code));
  });
}

function searchset(self: string, entry: unknown[], total: number): Record<string, unknown> {
  return { resourceType: "Bundle", type: "searchset", total, link: [{ relation: "self", url: self }], entry };
}

// ---------- imaging server ----------

export function handleImaging(cfg: Config, store: Store, caps: CapabilityStore, tok: ValidatedToken, req: Request, path: string[]): Response {
  const u = urls(cfg);
  const url = new URL(req.url);
  const [type, id] = path;
  if (req.method !== "GET") return outcome(405, "not-supported", "This server is read-only");

  if (type === "Endpoint" && cfg.endpointMode === "external") {
    if (id !== "wado-rs") return outcome(404, "not-found", `Endpoint/${id} not found`);
    return fhirJson(wadoEndpoint(cfg, "wado-rs", u.wado));
  }

  if (type !== "ImagingStudy") return outcome(404, "not-supported", `Resource type ${type} is not served here`);

  // Build an ImagingStudy plus the Endpoint entries it needs for this token.
  const render = (st: Study): { study: Record<string, unknown>; endpoints: { fullUrl: string; resource: Record<string, unknown>; always: boolean }[] } => {
    if (cfg.endpointMode === "contained") {
      return { study: imagingStudy(cfg, st, "#wado", wadoEndpoint(cfg, "wado", u.wado)), endpoints: [] };
    }
    if (cfg.endpointMode === "capability") {
      const cap = caps.issue(tok, st.uid);
      const uuid = crypto.randomUUID();
      return {
        study: imagingStudy(cfg, st, `urn:uuid:${uuid}`),
        endpoints: [{ fullUrl: `urn:uuid:${uuid}`, resource: wadoEndpoint(cfg, uuid, `${u.wado}/cap/${cap}`), always: true }],
      };
    }
    return {
      study: imagingStudy(cfg, st, "Endpoint/wado-rs"),
      endpoints: [{ fullUrl: `${u.imaging}/Endpoint/wado-rs`, resource: wadoEndpoint(cfg, "wado-rs", u.wado), always: false }],
    };
  };

  if (id) {
    const denied = need(tok, "ImagingStudy", "r");
    if (denied) return denied;
    const st = store.studiesById.get(id);
    if (!st || st.patientId !== tok.grant.patient || !tok.grant.studyUIDs.includes(st.uid)) return outcome(404, "not-found", `ImagingStudy/${id} not found`);
    if (cfg.endpointMode === "capability") {
      // A read has no Bundle to carry a response-local Endpoint, so the
      // token-bound capability Endpoint is contained instead.
      const cap = caps.issue(tok, st.uid);
      return fhirJson(imagingStudy(cfg, st, "#wado", wadoEndpoint(cfg, "wado", `${u.wado}/cap/${cap}`)));
    }
    return fhirJson(render(st).study);
  }

  const denied = need(tok, "ImagingStudy", "s");
  if (denied) return denied;
  const sp = url.searchParams;
  const pv = sp.get("patient") ?? sp.get("subject");
  if (!pv) return outcome(400, "required", "The patient search parameter is required");
  const pid = patientParam(cfg, pv);
  if (!pid || pid !== tok.grant.patient) return outcome(403, "forbidden", "The patient parameter does not match the token's patient context");

  let studies = visibleStudies(store, tok);
  const ids = sp.getAll("identifier");
  for (const v of ids) studies = studies.filter((st) => identifierMatches(st, v));
  const lus = sp.getAll("_lastUpdated");
  for (const v of lus) studies = studies.filter((st) => lastUpdatedMatches(st.lastUpdated, v));
  const includes = sp.getAll("_include");
  const wantEndpoints = includes.includes("ImagingStudy:endpoint") || includes.includes("*");

  const self = new URL(`${u.imaging}/ImagingStudy`);
  self.searchParams.set("patient", pid);
  for (const v of ids) self.searchParams.append("identifier", v);
  for (const v of lus) self.searchParams.append("_lastUpdated", v);
  if (wantEndpoints) self.searchParams.set("_include", "ImagingStudy:endpoint");

  const entries: unknown[] = [];
  const included = new Map<string, unknown>();
  for (const st of studies) {
    const r = render(st);
    entries.push({ fullUrl: `${u.imaging}/ImagingStudy/${st.id}`, resource: r.study, search: { mode: "match" } });
    for (const e of r.endpoints) {
      if ((e.always || wantEndpoints) && !included.has(e.fullUrl)) included.set(e.fullUrl, { fullUrl: e.fullUrl, resource: e.resource, search: { mode: "include" } });
    }
  }
  return fhirJson(searchset(self.toString(), [...entries, ...included.values()], studies.length));
}
