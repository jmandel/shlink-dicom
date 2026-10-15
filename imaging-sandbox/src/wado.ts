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

// Can we answer a bulk retrieval with the stored bytes?
function acceptsStoredDicom(accept: MediaRange[], instances: Instance[]): boolean {
  const syntaxes = new Set(instances.map((i) => i.transferSyntaxUID));
  return accept.some((m) => {
    if (m.params.q === "0") return false;
    if (m.type !== "multipart/related") return false;
    const t = (m.params.type ?? "application/dicom").toLowerCase();
    if (t !== "application/dicom") return false;
    const ts = m.params["transfer-syntax"];
    // An absent transfer-syntax means Explicit VR Little Endian in PS3.18,
    // which would need transcoding; the sandbox refuses it (406) instead.
    if (!ts) return false;
    if (ts === "*") return true;
    return syntaxes.size === 1 && syntaxes.has(ts);
  });
}

function acceptsJson(accept: MediaRange[]): boolean {
  return accept.some((m) => ["*/*", "application/*", "application/dicom+json", "application/json"].includes(m.type) && m.params.q !== "0");
}

function multipart(instances: Instance[], locate: (i: Instance) => string): Response {
  const boundary = `sandbox-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const parts: (Uint8Array | string)[] = [];
  let length = 0;
  for (const i of instances) {
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/dicom; transfer-syntax=${i.transferSyntaxUID}\r\nContent-Length: ${i.bytes.byteLength}\r\nContent-Location: ${locate(i)}\r\n\r\n`,
    );
    parts.push(head, i.bytes, enc.encode("\r\n"));
    length += head.byteLength + i.bytes.byteLength + 2;
  }
  const tail = enc.encode(`--${boundary}--\r\n`);
  parts.push(tail);
  length += tail.byteLength;
  return new Response(new Blob(parts as BlobPart[]), {
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

export function handleWado(cfg: Config, store: Store, caps: CapabilityStore, auth: AuthServer, tok: ValidatedToken, req: Request, path: string[], capId?: string): Response {
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

  if (!acceptsStoredDicom(accept, instances)) {
    const ts = [...new Set(instances.map((i) => i.transferSyntaxUID))].join(", ");
    return wadoError(406, `send Accept: multipart/related; type="application/dicom"; transfer-syntax=* (or the stored transfer syntax UID: ${ts}). This server returns stored instances and does not transcode.`);
  }
  return multipart(instances, locate);
}
