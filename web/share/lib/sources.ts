// The four ways imaging comes in: files and folders, a patient portal (SMART Imaging Access), a
// link someone gave you, and the public sample link. Each fills a Collection.
import { openShare, type OpenShare } from "../../core/share";
import { planRuns } from "../../core/range";
import { reportsForStudy } from "../../core/bundle";
import { Collection, expand } from "./ingest";
import * as S from "./smart";

export interface Progress {
  /** What is happening now, in plain words. */
  doing: string;
  /** Bytes read or downloaded so far, when known. */
  bytes?: number;
}
export type OnProgress = (c: Collection, p: Progress) => void;

/** Reads picked files and folders (and the archives among them) on this device. */
export async function loadFiles(files: File[], col: Collection, on: OnProgress, signal?: AbortSignal) {
  let read = 0;
  for (const f of files) {
    signal?.throwIfAborted();
    const name = (f as any).webkitRelativePath || f.name;
    on(col, { doing: `Reading ${name}`, bytes: read });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await f.arrayBuffer());
    } catch {
      col.skip(name, "could not be read");
      continue;
    }
    try {
      let n = 0;
      for await (const e of expand(name, bytes)) {
        col.add(e.name, e.bytes);
        if (++n % 25 === 0) on(col, { doing: `Reading ${name}`, bytes: read });
      }
    } catch (e) {
      col.skip(name, `archive could not be read (${(e as Error).message})`);
    }
    read += f.size;
    on(col, { doing: `Read ${name}`, bytes: read });
  }
  col.finish();
}

/** Opens a SMART Health Link and downloads, verifies and decrypts every series in it. */
export async function loadLink(share: OpenShare, col: Collection, on: OnProgress, signal?: AbortSignal) {
  const idx = share.index;
  if (idx.patient.name) {
    col.patient = { name: idx.patient.name, birthDate: idx.patient.birthDate, identifier: idx.patient.id ? [{ value: idx.patient.id }] : [] };
    col.patientSource = "fhir";
  }
  const total = idx.studies.reduce((a, s) => a + s.series.length, 0);
  let done = 0, bytes = 0;
  const say = () => on(col, { doing: `Downloaded ${done} of ${total} series`, bytes });
  // The loader runs several Range requests at once; instances are added in any order and sorted at the end.
  await Promise.all(
    idx.studies.flatMap((st) =>
      st.series.map(async (se) => {
        for (const plan of planRuns(se)) {
          signal?.throwIfAborted();
          const insts = await share.loader.run(se, plan, { signal });
          insts.forEach((b, k) => col.add(`${se.description ?? se.uid}/${plan.firstInstance + k + 1}`, b.slice()));
          bytes += plan.plaintextEnd - plan.plaintextStart;
          say();
        }
        done++;
        say();
      }),
    ),
  );
  for (const st of idx.studies) {
    const m = col.studies.get(st.studyInstanceUid);
    if (m) {
      if (st.started) m.started = st.started;
      if (st.description) m.description = st.description;
      const reportIds = new Set(reportsForStudy(idx, st).map((r) => r.id));
      m.reports = (idx.bundle.entry ?? [])
        .map((e: any) => e.resource)
        .filter((r: any) => r?.resourceType === "DiagnosticReport" && reportIds.has(r.id));
    }
  }
  col.finish();
}

// -------------------------------------------------------------------------------------- portal

const SMART_KEY = "shl-dicom-share-smart";

export function defaultPortal(): string {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" ? `http://${h}:3334/fhir` : "https://smart-imaging-sandbox.exe.xyz/fhir";
}

export function callbackUrl(siteShareUrl: string): string {
  return new URL("smart-callback/", siteShareUrl.replace(/\/?$/, "/")).toString();
}

/** Step 1 of the launch: discovery, then a full-page redirect to the portal's sign-in. */
export async function startPortalLaunch(fhirBase: string, redirectUri: string) {
  const d = await S.discover(fhirBase);
  const { verifier, challenge } = await S.pkce();
  const state = crypto.randomUUID();
  try {
    sessionStorage.setItem(SMART_KEY, JSON.stringify({ d, verifier, state, redirectUri }));
  } catch {
    throw new Error("This browser blocks session storage, which the portal sign-in needs.");
  }
  location.assign(S.authorizeUrl(d, { redirectUri, state, challenge }));
}

export interface PortalSession {
  d: S.Discovery;
  token: Record<string, any>;
}

/** Step 2: back from the portal with ?code=…&state=…. Returns null when this isn't a callback. */
export async function finishPortalLaunch(search: string): Promise<PortalSession | null> {
  const q = new URLSearchParams(search);
  if (!q.has("code") && !q.has("error")) return null;
  let saved: any = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SMART_KEY) ?? "null");
    sessionStorage.removeItem(SMART_KEY);
  } catch {}
  if (!saved) throw new Error("The portal sign-in started in another tab or expired. Try again.");
  if (q.get("state") !== saved.state) throw new Error("The portal's answer did not match this sign-in. Try again.");
  if (q.has("error")) throw new Error(q.get("error") === "access_denied" ? "You did not allow access at the portal." : `The portal returned an error (${q.get("error")}).`);
  const token = await S.exchangeCode(saved.d, { code: q.get("code")!, verifier: saved.verifier, redirectUri: saved.redirectUri });
  return { d: saved.d, token };
}

/** Searches the patient's imaging and reports, then retrieves every series over WADO-RS. */
export async function loadPortal(sess: PortalSession, col: Collection, on: OnProgress, signal?: AbortSignal) {
  const { d } = sess;
  const tok = sess.token.access_token as string;
  const pid = sess.token.patient as string;
  on(col, { doing: "Reading your record at the portal" });
  try {
    const p = await S.fhirGet(`${d.clinicalBase}/Patient/${encodeURIComponent(pid)}`, tok);
    const n = p.name?.[0];
    col.patient = {
      name: n?.text ?? ([...(n?.given ?? []), n?.family].filter(Boolean).join(" ") || null),
      birthDate: p.birthDate ?? null,
      identifier: (p.identifier ?? []).filter((i: any) => i.value).map((i: any) => ({ ...(i.system ? { system: i.system } : {}), value: i.value })),
    };
    col.patientSource = "fhir";
  } catch {}
  const pages = await S.fhirSearchAll(`${d.imagingBase}/ImagingStudy?patient=${encodeURIComponent(pid)}&_include=ImagingStudy:endpoint`, tok);
  const found = pages.flatMap(S.studiesFromBundle);
  let reports: any[] = [];
  try {
    const rp = await S.fhirSearchAll(`${d.clinicalBase}/DiagnosticReport?patient=${encodeURIComponent(pid)}`, tok);
    reports = rp.flatMap((b) => (b.entry ?? []).map((e: any) => e.resource).filter((r: any) => r?.resourceType === "DiagnosticReport"));
  } catch {}
  const total = found.reduce((a, f) => a + Math.max(1, f.study.series?.length ?? 0), 0);
  let done = 0, bytes = 0;
  for (const f of found) {
    const series: any[] = f.study.series?.length ? f.study.series : [null];
    for (const se of series) {
      signal?.throwIfAborted();
      on(col, { doing: `Downloading series ${done + 1} of ${total} from the portal`, bytes });
      const url = se ? `${f.wadoBase}/studies/${f.studyUID}/series/${se.uid}` : `${f.wadoBase}/studies/${f.studyUID}`;
      const parts = await S.wadoRetrieve(url, tok);
      parts.forEach((b, k) => col.add(`${se?.description ?? f.studyUID}/${k + 1}`, b));
      bytes += parts.reduce((a, b) => a + b.length, 0);
      done++;
      on(col, { doing: `Downloading series ${done} of ${total} from the portal`, bytes });
    }
    const m = col.studies.get(f.studyUID);
    if (m) {
      if (f.study.started) m.started = f.study.started;
      if (f.study.description) m.description = f.study.description;
      const mine = reports.filter((r) =>
        (r.imagingStudy ?? []).some(
          (ref: any) =>
            ref.identifier?.value === `urn:oid:${f.studyUID}` || String(ref.reference ?? "").replace(/^.*ImagingStudy\//, "") === f.study.id,
        ),
      );
      on(col, { doing: "Downloading reports", bytes });
      m.reports = await Promise.all(mine.map((r) => S.inlineAttachments(r, tok)));
    }
  }
  col.finish();
}
