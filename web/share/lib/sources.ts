// The four ways imaging comes in: files and folders, a patient portal (SMART Imaging Access), a
// link someone gave you, and the public sample link. Each fills a Collection.
import type { OpenShare } from "../../core/share";
import { planBytes, RECORD_PLAINTEXT } from "../../core/range";
import { parseDicomSync, T } from "../../core/dicom";
import type { SeriesEntry } from "../../core/bundle";
import type { DicomHeader } from "../../core/dicom-header";
import { linksTakenWhenSharing } from "../../core/reports";
import { BlobBytes, SubBytes, type Bytes } from "./bytes";
import { formatBytes, plural } from "../../core/format";
import { Collection, expand } from "./ingest";
import type { Stager } from "./stage";
import * as S from "./smart";
import { loadShlWasm } from "./shl-wasm";

export interface Progress {
  /** What is happening now, in plain words (including the measured amounts). */
  doing: string;
  /** Measured work done of a known total, in one unit; absent when the total isn't known. */
  done?: number;
  total?: number;
  /** For the headline: the whole selection, when the source says it before downloading. */
  expected?: { studies: number; series: number; images: number };
}
export type OnProgress = (c: Collection, p: Progress) => void;

/**
 * Collects picked files and folders (and the archives among them). Only headers are read here;
 * gzip archives and deflated ZIP entries are decompressed into the stager as they are read.
 */
/** Series retrieved at once from a SMART Imaging Access server. */
const SERIES_AT_ONCE = 3;

export async function loadFiles(files: File[], col: Collection, stager: Stager, on: OnProgress, signal?: AbortSignal) {
  // Measured by bytes of the picked files: each file counts when it has been read through
  // (only headers for loose files), an archive as its bytes are consumed.
  const total = files.reduce((a, f) => a + f.size, 0);
  let read = 0;
  const say = (at: number, name: string) => on(col, { doing: `Reading ${formatBytes(read + at)} of ${formatBytes(total)} · ${name}`, done: read + at, total });
  for (const f of files) {
    signal?.throwIfAborted();
    const name = (f as any).webkitRelativePath || f.name;
    say(0, name);
    let at = 0;
    try {
      let n = 0;
      for await (const e of expand(name, new BlobBytes(f), stager, 0, (pos) => (at = Math.max(at, Math.min(pos, f.size))))) {
        signal?.throwIfAborted();
        await col.add(e.name, e.src);
        if (++n % 25 === 0) say(at, name);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      col.skip(name, `could not be read (${(e as Error).message})`);
    }
    read += f.size;
    say(0, name);
  }
  await col.finish();
}

/** One series of a shared link as a byte source: Range reads, verified and decrypted on demand. */
class LinkSeriesBytes implements Bytes {
  constructor(
    readonly share: OpenShare,
    readonly se: SeriesEntry,
  ) {}
  get size() {
    return this.se.bytes;
  }
  /** Bytes [a, b) of the series, which starts at se.offset in its file. */
  async read(a: number, b: number) {
    b = Math.min(b, this.size);
    if (a >= b) return new Uint8Array(0);
    const plan = planBytes(this.se, this.se.offset + a, this.se.offset + b);
    // A read that stalls fails after a minute; the upload waits it out and asks again.
    const ct = await this.share.resolver.fetchRange(plan, AbortSignal.timeout(60000));
    return this.share.decryptor.decrypt(this.se, plan, ct);
  }
}

/**
 * Opens a SMART Health Link's studies from its Bundle without downloading them. Images are read
 * when they are shown or packed, as byte ranges of the link's encrypted files.
 */
export async function loadLink(share: OpenShare, col: Collection, on: OnProgress) {
  const idx = share.index;
  if (idx.patient.name) {
    const humanName = (idx.bundle.entry ?? []).find((e: any) => e.resource?.resourceType === "Patient")?.resource.name?.[0] ?? { text: idx.patient.name };
    col.patient = { name: idx.patient.name, humanName, birthDate: idx.patient.birthDate, identifier: idx.patient.id ? [{ value: idx.patient.id }] : [] };
    col.patientSource = "fhir";
  }
  // Each series' transfer syntax, from its first instance's file meta (the first record of the
  // series): the Bundle doesn't give it, and compression and offset tables need it.
  const all = idx.studies.flatMap((st) => st.series);
  const syntax = new Map<SeriesEntry, string>();
  let read = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, all.length) }, async (_, w) => {
      for (let i = w; i < all.length; i += 6) {
        syntax.set(all[i], await seriesSyntax(share, all[i]));
        on(col, { doing: `Reading the link's series: ${++read} of ${all.length}`, done: read, total: all.length });
      }
    }),
  );
  for (const st of idx.studies) {
    for (const se of st.series) {
      const src = new LinkSeriesBytes(share, se);
      for (const [k, inst] of se.instances.entries()) {
        const h = blankHeader();
        Object.assign(h, {
          transferSyntax: syntax.get(se) ?? "",
          sopInstanceUid: inst.uid,
          sopClassUid: inst.sopClass,
          studyInstanceUid: st.studyInstanceUid,
          seriesInstanceUid: se.uid,
          modality: se.modality ?? "",
          studyDescription: st.description ?? "",
          seriesDescription: se.description ?? "",
          seriesNumber: se.number != null ? String(se.number) : "",
          instanceNumber: inst.number != null ? String(inst.number) : "",
          accessionNumber: st.accession ?? "",
        });
        // inst.offset is in the file; the series source starts at se.offset.
        col.addWithHeader(`${se.description ?? se.uid}/${k + 1}`, new SubBytes(src, inst.offset - se.offset, inst.length), h);
      }
    }
    on(col, { doing: "Reading the link's Bundle" });
    const m = col.studies.get(st.studyInstanceUid);
    if (m) {
      if (st.started) m.started = st.started;
      if (st.description) m.description = st.description;
      const reportIds = new Set(linksTakenWhenSharing(idx).filter((l) => l.studyId === st.id).map((l) => l.report.id));
      m.reports = (idx.bundle.entry ?? [])
        .map((e: any) => e.resource)
        .filter((r: any) => r?.resourceType === "DiagnosticReport" && reportIds.has(r.id))
        .map((resource: any) => ({ resource, include: true, from: "link" as const }));
    }
  }
  // Reports in the link that name none of its studies (or only match by date): kept, left out until chosen.
  const linked = new Set(linksTakenWhenSharing(idx).map((l) => l.report.id));
  col.looseReports = (idx.bundle.entry ?? [])
    .map((e: any) => e.resource)
    .filter((r: any) => r?.resourceType === "DiagnosticReport" && !linked.has(r.id))
    .map((resource: any) => ({ resource, include: false, from: "link" as const }));
  await col.finish();
}

/** The transfer syntax of a series' first instance, from its file meta ("" when it can't be read). */
async function seriesSyntax(share: OpenShare, se: SeriesEntry): Promise<string> {
  const inst = se.instances[0];
  try {
    const head = await new LinkSeriesBytes(share, se).read(inst.offset - se.offset, inst.offset - se.offset + Math.min(inst.length, RECORD_PLAINTEXT));
    return parseDicomSync(head, { untilPixelData: true }).meta.str(T.TransferSyntaxUID) ?? "";
  } catch {
    return "";
  }
}

function blankHeader(): DicomHeader {
  return {
    transferSyntax: "", sopClassUid: "", sopInstanceUid: "", patientName: "", patientId: "", patientIdIssuer: "", patientBirthDate: "",
    patientSex: "", studyDate: "", studyTime: "", accessionNumber: "", studyDescription: "", studyInstanceUid: "",
    studyId: "", referringPhysician: "", seriesInstanceUid: "", modality: "", seriesNumber: "", seriesDescription: "",
    instanceNumber: "", specificCharacterSet: "",
  } as DicomHeader;
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
export async function loadPortal(sess: PortalSession, col: Collection, stager: Stager, on: OnProgress, signal?: AbortSignal) {
  const { d } = sess;
  const tok = S.portalAuth(d, sess.token.access_token as string);
  const pid = sess.token.patient as string;
  on(col, { doing: "Reading your record at the portal" });
  try {
    const p = await S.fhirGet(`${d.clinicalBase}/Patient/${encodeURIComponent(pid)}`, tok);
    const n = p.name?.[0];
    col.patient = {
      name: n?.text ?? ([...(n?.given ?? []), n?.family].filter(Boolean).join(" ") || null),
      humanName: n ?? null,
      birthDate: p.birthDate ?? null,
      identifier: (p.identifier ?? []).filter((i: any) => i.value).map((i: any) => ({ ...(i.system ? { system: i.system } : {}), value: i.value })),
    };
    col.patientSource = "fhir";
  } catch {}
  const pages = await S.fhirSearchAll(`${d.imagingBase}/ImagingStudy?patient=${encodeURIComponent(pid)}&_include=ImagingStudy:endpoint`, tok);
  const found = pages.flatMap((b) => S.studiesFromBundle(b, tok));
  let reports: any[] = [];
  try {
    const rp = await S.fhirSearchAll(`${d.clinicalBase}/DiagnosticReport?patient=${encodeURIComponent(pid)}`, tok);
    reports = rp.flatMap((b) => (b.entry ?? []).map((e: any) => e.resource).filter((r: any) => r?.resourceType === "DiagnosticReport"));
  } catch {}
  // Accession numbers read from image headers, by ImagingStudy id, for studies whose search result has none.
  const headerAccessions: Record<string, string> = {};
  // The search results say how many series and images there are before anything is downloaded.
  const total = found.reduce((a, f) => a + Math.max(1, f.study.series?.length ?? 0), 0);
  const images = found.reduce(
    (a, f) => a + (f.study.numberOfInstances ?? (f.study.series ?? []).reduce((b: number, se: any) => b + (se.numberOfInstances ?? se.instance?.length ?? 0), 0)),
    0,
  );
  const expected = { studies: found.length, series: total, images };
  let done = 0, bytes = 0, got = 0;
  const used = new Set<any>();
  const say = () =>
    on(col, {
      doing: images
        ? `Downloading ${Math.min(got, images)} of ${images} images · ${done} of ${total} series · ${formatBytes(bytes)} so far`
        : `Downloading ${done} of ${total} series · ${formatBytes(bytes)} so far`,
      ...(images ? { done: Math.min(got, images), total: images } : { done, total }),
      expected,
    });
  for (const f of found) {
    const series: any[] = f.study.series?.length ? f.study.series : [null];
    // A few series at once: one retrieve at a time leaves the connection idle between series and
    // runs at one response's speed (series are sorted when the collection is finished).
    let next = 0;
    const one = async (se: any) => {
      signal?.throwIfAborted();
      say();
      const url = se ? `${f.wadoBase}/studies/${f.studyUID}/series/${se.uid}` : `${f.wadoBase}/studies/${f.studyUID}`;
      const name = se?.description ?? f.studyUID;
      let k = 0;
      for await (const part of S.wadoRetrieveParts(url, tok, signal)) {
        // The file's own meta header says its transfer syntax; the part's Content-Type is counted for the log.
        if (part.transferSyntax) col.received.set(part.transferSyntax, (col.received.get(part.transferSyntax) ?? 0) + 1);
        const src = await stager.stage(`${name}/${++k}`, part.body);
        await col.add(`${name}/${k}`, src);
        bytes += src.size;
        got++;
        say();
      }
      done++;
      say();
    };
    await Promise.all(
      Array.from({ length: Math.min(SERIES_AT_ONCE, series.length) }, async () => {
        while (next < series.length) await one(series[next++]);
      }),
    );
    const m = col.studies.get(f.studyUID);
    if (m) {
      if (f.study.started) m.started = f.study.started;
      if (f.study.description) m.description = f.study.description;
      const acsn = (f.study.identifier ?? []).find((i: any) => (i.type?.coding ?? []).some((c: any) => c.code === "ACSN"))?.value;
      if (!m.accession && acsn) m.accession = acsn;
      // Reports that belong to this study by the viewer's rule (shl_dicom_core::report_links),
      // except by date alone; a combined report goes with each study it names.
      if (m.accession && !acsn) headerAccessions[f.study.id] = m.accession;
      const links: { studyId: string; basis: string }[][] = JSON.parse(
        (await loadShlWasm()).link_portal_reports(JSON.stringify(found.map((g) => g.study)), JSON.stringify(reports), JSON.stringify(headerAccessions)),
      );
      const mine = reports.filter((_, i) => links[i].some((l) => l.studyId === f.study.id && l.basis !== "date"));
      on(col, { doing: `Downloading the reports · ${images ? Math.min(got, images) : got} of ${images || got} images downloaded`, ...(images ? { done: Math.min(got, images), total: images } : {}), expected });
      m.reports = (await Promise.all(mine.map((r) => S.inlineAttachments(r, tok)))).map((resource) => ({ resource, include: true, from: "portal" as const }));
      for (const r of mine) used.add(r);
    }
  }
  // The patient's other reports, which name none of these studies: offered, left out until chosen.
  const others = reports.filter((r) => !used.has(r));
  if (others.length) {
    on(col, { doing: `Downloading ${plural(others.length, "other report")}`, expected });
    col.looseReports = (await Promise.all(others.map((r) => S.inlineAttachments(r, tok)))).map((resource) => ({ resource, include: false, from: "portal" as const }));
  }
  await col.finish();
}
