// DICOMweb WADO-RS retrieval: study, series and instance as
// multipart/related; type="application/dicom", plus /metadata as DICOM
// JSON. Every request is checked against the SMART access token: active,
// ImagingStudy read scope, the token's patient owns the study, and the
// user chose to share the study. Capability URLs (/wado-rs/cap/{id}/...)
// are additionally bound to one grant (the user's consent, which survives
// token refresh) and one study.

import type { Config } from "./config.ts";
import type { Store, Study, Instance } from "./data.ts";
import type { ValidatedToken, AuthServer } from "./auth.ts";
import { scopeAllows } from "./scopes.ts";
import { toDicomJson } from "./dicom.ts";

interface Capability { id: string; grantId: string; studyUID: string; exp: number; }

export class CapabilityStore {
  private caps = new Map<string, Capability>();
  constructor(private cfg: Config) {}

  issue(tok: ValidatedToken, studyUID: string): string {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + this.cfg.capabilityTtl;
    this.caps.set(id, { id, grantId: tok.grant.id, studyUID, exp });
    for (const [k, c] of this.caps) if (c.exp < Date.now() / 1000 - 3600) this.caps.delete(k);
    return id;
  }

  get(id: string): Capability | undefined {
    return this.caps.get(id);
  }
}

function wadoError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
}

interface MediaRange { type: string; params: Record<string, string>; }

function parseAccept(h: string | null): MediaRange[] {
  if (!h) return [{ type: "*/*", params: {} }];
  return h.split(",").map((part) => {
    // Split on ; outside quotes.
    const bits = part.match(/(?:[^;"]+|"[^"]*")+/g) ?? [];
    const type = (bits.shift() ?? "").trim().toLowerCase();
    const params: Record<string, string> = {};
    for (const b of bits) {
      const eq = b.indexOf("=");
      if (eq < 0) continue;
      params[b.slice(0, eq).trim().toLowerCase()] = b.slice(eq + 1).trim().replace(/^"|"$/g, "");
    }
    return { type, params };
  }).filter((m) => m.type);
}

// Transfer syntax negotiation (PS3.18 8.7; argonautproject/smart-imaging
// PR #5). Each multipart/related; type=application/dicom range names one
// transfer syntax and an optional q weight (default 1). "*" means "as
// stored". For each instance the server picks the highest-weighted syntax it
// can provide: the stored one, or a losslessly compressed copy. A range
// without transfer-syntax would mean Explicit VR Little Endian, which the
// sandbox refuses with 406 so that apps learn to send the parameter.
interface Preference { ts: string; q: number; order: number }

function dicomPreferences(accept: MediaRange[]): { prefs: Preference[]; missing: boolean } {
  const prefs: Preference[] = [];
  let missing = false;
  accept.forEach((m, order) => {
    if (m.type !== "multipart/related") return;
    if ((m.params.type ?? "application/dicom").toLowerCase() !== "application/dicom") return;
    const q = qOf(m);
    // q=0 means "not acceptable": such a range asks for nothing, so it can't be missing a syntax.
    if (q === 0) return;
    const ts = m.params["transfer-syntax"];
    if (!ts) { missing = true; return; }
    prefs.push({ ts, q, order });
  });
  return { prefs: prefs.filter((p) => p.q > 0).sort((a, b) => b.q - a.q || a.order - b.order), missing };
}

interface Part { instance: Instance; ts: string; size: number; body: Uint8Array; file?: string }

// The part to send for one instance, or null if no preference can be met.
function choose(i: Instance, prefs: Preference[]): Part | null {
  for (const p of prefs) {
    if (p.ts === "*" || p.ts === i.transferSyntaxUID) return { instance: i, ts: i.transferSyntaxUID, size: i.bytes.byteLength, body: i.bytes };
    const v = i.variants.get(p.ts);
    if (v) return { instance: i, ts: p.ts, size: v.size, body: new Uint8Array(0), file: v.file };
  }
  return null;
}

function acceptsJson(accept: MediaRange[]): boolean {
  return accept.some((m) => ["*/*", "application/*", "application/dicom+json", "application/json"].includes(m.type) && qOf(m) > 0);
}

// A range's q weight as a number in [0, 1] (absent or unreadable: 1), so "0", "0.0" and "0.000" all
// mean "not acceptable".
function qOf(m: MediaRange): number {
  const raw = m.params.q === undefined ? 1 : Number(m.params.q);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 1;
}

function multipart(parts: Part[], locate: (i: Instance) => string): Response {
  const boundary = `sandbox-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const p of parts) {
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/dicom; transfer-syntax=${p.ts}\r\nContent-Length: ${p.size}\r\nContent-Location: ${locate(p.instance)}\r\n\r\n`,
    );
    chunks.push(head, p.body, enc.encode("\r\n"));
    length += head.byteLength + p.size + 2;
  }
  const tail = enc.encode(`--${boundary}--\r\n`);
  chunks.push(tail);
  length += tail.byteLength;
  return new Response(new Blob(chunks as BlobPart[]), {
    status: 200,
    headers: {
      "content-type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
      "content-length": String(length),
      "cache-control": "no-store",
    },
  });
}

// path: segments after /wado-rs (or after /wado-rs/cap/{id}).
// One response for every study-level denial, so unknown and unauthorized
// studies cannot be told apart.
const STUDY_DENIED = () => wadoError(403, "access to the requested study is not authorized");

export async function handleWado(cfg: Config, store: Store, caps: CapabilityStore, auth: AuthServer, tok: ValidatedToken, req: Request, path: string[], capId?: string): Promise<Response> {
  if (req.method !== "GET") return wadoError(405, "WADO-RS retrieval is read-only");
  const base = capId ? `${cfg.baseUrl}/wado-rs/cap/${capId}` : `${cfg.baseUrl}/wado-rs`;

  // 1. Scope.
  if (!scopeAllows(tok.grant.scopes, "ImagingStudy", "r")) {
    return wadoError(403, "the token's scopes do not include ImagingStudy read access", {
      "www-authenticate": 'Bearer realm="imaging-sandbox", error="insufficient_scope", scope="patient/ImagingStudy.r"',
    });
  }

  // 2. Capability, when the URL carries one.
  if (capId) {
    const cap = caps.get(capId);
    if (!cap || cap.grantId !== tok.grant.id || !auth.grantActive(cap.grantId) || cap.exp <= Date.now() / 1000) {
      return wadoError(403, "this retrieval URL is expired, revoked, or bound to another authorization; search ImagingStudy again");
    }
    if (path[1] !== cap.studyUID) return STUDY_DENIED();
  }

  if (path[0] !== "studies" || !path[1]) return wadoError(404, "use /studies/{StudyInstanceUID}[/series/{uid}[/instances/{uid}]][/metadata]");

  // 3. Study-level authorization: the token's patient owns the study and
  // the user shared it. Unknown and unauthorized studies get the same 403,
  // so the response does not reveal whether a study exists.
  const study: Study | undefined = store.studies.get(path[1]);
  if (!study || study.patientId !== tok.grant.patient || !tok.grant.studyUIDs.includes(study.uid)) return STUDY_DENIED();

  let rest = path.slice(2);
  let wantMetadata = false;
  if (rest[rest.length - 1] === "metadata") { wantMetadata = true; rest = rest.slice(0, -1); }

  let instances: Instance[];
  if (rest.length === 0) {
    instances = study.series.flatMap((s) => s.instances);
  } else if (rest[0] === "series" && rest[1]) {
    const series = study.series.find((s) => s.uid === rest[1]);
    if (!series) return wadoError(404, "series not found in this study");
    if (rest.length === 2) instances = series.instances;
    else if (rest[2] === "instances" && rest[3] && rest.length === 4) {
      const inst = series.instances.find((i) => i.sopInstanceUID === rest[3]);
      if (!inst) return wadoError(404, "instance not found in this series");
      instances = [inst];
    } else {
      return wadoError(404, "not supported by this server (frames, rendered and thumbnail are not implemented); retrieve the study, series or instance instead");
    }
  } else {
    return wadoError(404, "not supported by this server; retrieve the study, series or instance instead");
  }

  const seriesOf = (i: Instance) => study.series.find((s) => s.instances.includes(i))!.uid;
  const locate = (i: Instance) => `${base}/studies/${study.uid}/series/${seriesOf(i)}/instances/${i.sopInstanceUID}`;
  const accept = parseAccept(req.headers.get("accept"));

  if (wantMetadata) {
    if (!acceptsJson(accept)) return wadoError(406, "metadata is available as application/dicom+json");
    const body = instances.map((i) => toDicomJson(i.header));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/dicom+json", "cache-control": "no-store" } });
  }

  const { prefs, missing } = dicomPreferences(accept);
  const offered = () => {
    const stored = [...new Set(instances.map((i) => i.transferSyntaxUID))];
    const copies = [...new Set(instances.flatMap((i) => [...i.variants.keys()]))];
    return { stored, losslessCopies: copies };
  };
  const example = 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.70, multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.4.90; q=0.9, multipart/related; type="application/dicom"; transfer-syntax=*; q=0.5';
  if (missing || prefs.length === 0) {
    return new Response(JSON.stringify({
      error: "Accept must name a transfer syntax: send multipart/related; type=\"application/dicom\"; transfer-syntax=* (as stored), optionally preceded by preferred lossless syntaxes with q weights.",
      example,
      available: offered(),
    }), { status: 406, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const parts: Part[] = [];
  for (const i of instances) {
    const p = choose(i, prefs);
    if (!p) {
      return new Response(JSON.stringify({
        error: "None of the requested transfer syntaxes is available for every instance. Add transfer-syntax=* to accept instances as stored.",
        requested: prefs.map((x) => x.ts),
        example,
        available: offered(),
      }), { status: 406, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    parts.push(p);
  }
  // Copies are read from disk when sent.
  for (const p of parts) {
    if (p.file) {
      p.body = await Bun.file(p.file).bytes();
      if (p.body.byteLength !== p.size) return wadoError(500, "a compressed copy changed on disk");
    }
  }
  return multipart(parts, locate);
}
