// End-to-end test for the imaging sandbox.
//
//   bun test/e2e.ts                 start sandboxes in-process and test them
//   bun test/e2e.ts --base URL      test a running sandbox (skips the tests
//                                   that need special server settings)
//
// The main flow runs in headless Chromium on a page at another origin
// (a stand-in page on its own loopback port), as the Share app
// would: discovery, authorize with the demo login and consent page, PKCE
// token exchange, Patient read, ImagingStudy search, and WADO-RS retrieval
// of every series. Retrieved instances are compared byte for byte with the
// files of the built dataset (build/dataset, from scripts/build-data.ts).

import { chromium } from "playwright-core";
import { join, resolve } from "node:path";
import * as C from "./client.ts";
import { launchViaForms, type LaunchOptions } from "./launch.ts";
import { parseDicom, str } from "../src/dicom.ts";
import { pdfPages } from "./pdf-text.ts";
import type { Sandbox } from "../src/server.ts";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "..");
const DATASET = resolve(process.env.DATASET_DIR ?? join(ROOT, "build/dataset"));
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 3341);
// The stand-in app page is served from a real loopback server, so Chromium
// treats app and sandbox as the same (loopback) address space.
const APP_PORT = PORT_BASE + 9;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const REDIRECT = `${APP_ORIGIN}/share/smart-callback`;
const FULL_SCOPE = "launch/patient patient/Patient.rs patient/DiagnosticReport.rs patient/ImagingStudy.rs offline_access";
const PATIENT = "josh-example";
let CLIENT_ID = "shlink-dicom-share";
const OTHER_PATIENT = "robin-example";

const args = process.argv.slice(2);
const remoteBase = args.includes("--base") ? args[args.indexOf("--base") + 1].replace(/\/+$/, "") : null;
const introspectionKey = process.env.INTROSPECTION_KEY ?? (remoteBase ? undefined : "e2e-introspection-key");

// ---------- tiny assertion harness ----------

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
function section(s: string) { console.log(`\n${s}`); }

// ---------- ground truth: the built dataset ----------
// (test/data-check.ts compares the built files with the source archives.)

interface Truth { bytes: Uint8Array; sha: string; studyUID: string; seriesUID: string; sopUID: string; }
const truthBySop = new Map<string, Truth>();
const truthBySeries = new Map<string, Truth[]>();
const studyUIDById = new Map<string, string>();
let manifest: any;

async function loadTruth() {
  manifest = JSON.parse(await Bun.file(join(DATASET, "manifest.json")).text());
  for (const st of manifest.studies) {
    studyUIDById.set(st.id, st.studyInstanceUID);
    for (const f of st.files) {
      const bytes = new Uint8Array(await Bun.file(join(DATASET, f.path)).arrayBuffer());
      const ds = parseDicom(bytes).dataset;
      const t: Truth = { bytes, sha: await C.sha256Hex(bytes), studyUID: str(ds, 0x0020000d)!, seriesUID: str(ds, 0x0020000e)!, sopUID: str(ds, 0x00080018)! };
      if (t.sha !== f.sha256) throw new Error(`${f.path} does not match manifest.json`);
      truthBySop.set(t.sopUID, t);
      if (!truthBySeries.has(t.seriesUID)) truthBySeries.set(t.seriesUID, []);
      truthBySeries.get(t.seriesUID)!.push(t);
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- sandboxes ----------

type Mode = "external" | "contained" | "capability";
const running: { stop: () => void }[] = [];
const sandboxes = new Map<string, Sandbox>();

async function start(port: number, env: Record<string, string>): Promise<string> {
  const { startSandbox } = await import("../src/server.ts");
  const base = `http://localhost:${port}`;
  const sb = await startSandbox({ PORT: String(port), BASE_URL: base, LOG_REQUESTS: "0", INTROSPECTION_KEY: introspectionKey!, DATASET_DIR: DATASET, SHARE_REDIRECT_URIS: REDIRECT, ...env });
  running.push({ stop: () => sb.server.stop(true) });
  sandboxes.set(base, sb);
  return base;
}

// ---------- HTTP launch helper (drives the login and consent forms) ----------

function httpLaunch(base: string, o: LaunchOptions = {}) {
  return launchViaForms(base, { patient: PATIENT, scope: FULL_SCOPE, clientId: CLIENT_ID, redirectUri: REDIRECT, ...o });
}

async function status(url: string, token?: string, init: RequestInit = {}): Promise<number> {
  const headers: Record<string, string> = { accept: C.DICOM_ACCEPT, ...(init.headers as any) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { ...init, headers });
  await r.arrayBuffer();
  return r.status;
}

// Retrieve every series of every found study in Node and compare bytes.
async function retrieveAndCompare(label: string, studies: C.FoundStudy[], token: string, expectStudies: string[]) {
  check(`${label}: search returned the expected studies`, JSON.stringify(studies.map((s) => s.studyUID).sort()) === JSON.stringify([...expectStudies].sort()), studies.map((s) => s.studyUID));
  let instances = 0, identical = 0;
  for (const s of studies) {
    for (const series of s.study.series) {
      const res = await C.wadoGet(`${s.wadoBase}/studies/${s.studyUID}/series/${series.uid}`, token);
      if (res.status !== 200 || !res.parts) { check(`${label}: series ${series.uid} retrieved`, false, res.status); continue; }
      const truth = truthBySeries.get(series.uid) ?? [];
      if (res.parts.length !== truth.length) check(`${label}: series ${series.uid} instance count`, false, `${res.parts.length} vs ${truth.length}`);
      for (const p of res.parts) {
        instances++;
        const sop = str(parseDicom(p.bytes).dataset, 0x00080018)!;
        const t = truthBySop.get(sop);
        if (t && t.seriesUID === series.uid && sameBytes(t.bytes, p.bytes)) identical++;
      }
    }
  }
  const expected = expectStudies.reduce((a, uid) => a + [...truthBySop.values()].filter((t) => t.studyUID === uid).length, 0);
  check(`${label}: ${identical}/${expected} instances retrieved by series are byte-identical to the built dataset`, identical === expected && instances === expected, { instances, identical, expected });
}

// ---------- browser flow ----------

async function browserFlow(base: string) {
  section(`Browser flow (Chromium, app origin ${APP_ORIGIN}) against ${base}`);
  const build = await Bun.build({ entrypoints: [join(HERE, "browser-entry.ts")], target: "browser", format: "iife", minify: false });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const clientJs = await build.outputs[0].text();

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`  browser console: ${m.text()}`); });

    // 1. Discovery and the authorize redirect, from the app page.
    await page.goto(`${APP_ORIGIN}/share/`);
    await page.addScriptTag({ content: clientJs });
    const start = await page.evaluate(async ({ base, clientId, redirectUri, scope }) => {
      const C = (globalThis as any).SmartImagingClient;
      const d = await C.discover(`${base}/fhir`);
      const { verifier, challenge } = await C.pkce();
      const state = crypto.randomUUID();
      sessionStorage.setItem("launch", JSON.stringify({ verifier, state, d }));
      return { url: C.authorizeUrl(d, { clientId, redirectUri, scope, state, challenge }), imagingBase: d.imagingBase, caps: d.smart.capabilities, assoc: d.smart.associated_endpoints };
    }, { base, clientId: CLIENT_ID, redirectUri: REDIRECT, scope: FULL_SCOPE });
    check("discovery: imaging endpoint found via associated_endpoints", start.imagingBase === `${base}/imaging/fhir`, start.assoc);

    // 2. Demo login and consent, clicked like a person would.
    await page.goto(start.url);
    check("login page shown", (await page.locator("h1").textContent()) === "Sign in");
    await page.locator(`input[name=patient][value=${PATIENT}]`).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Allow access?");
    check(`consent page lists all ${manifest.studies.length} studies`, (await page.locator("input[name=study]").count()) === manifest.studies.length);
    await Promise.all([page.waitForURL(`${REDIRECT}**`), page.getByRole("button", { name: "Allow" }).click()]);

    // 3. Back in the app: token exchange and all fetches, cross-origin.
    await page.addScriptTag({ content: clientJs });
    const out = await page.evaluate(async ({ clientId, redirectUri }) => {
      const C = (globalThis as any).SmartImagingClient;
      const { verifier, state, d } = JSON.parse(sessionStorage.getItem("launch")!);
      const q = new URLSearchParams(location.search);
      if (q.get("state") !== state) throw new Error("state mismatch");
      const token = await C.exchangeCode(d, { code: q.get("code"), verifier, clientId, redirectUri });
      const patient = await C.fhirGet(`${d.clinicalBase}/Patient/${token.patient}`, token.access_token);
      const reports = await C.fhirGet(`${d.clinicalBase}/DiagnosticReport?patient=${token.patient}&category=RAD`, token.access_token);
      const pdfAtt = reports.entry[0].resource.presentedForm.find((a: any) => a.contentType === "application/pdf");
      const pdfRes = await fetch(pdfAtt.url, { headers: { authorization: `Bearer ${token.access_token}` } });
      const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
      const pdfFetch = { status: pdfRes.status, type: pdfRes.headers.get("content-type"), size: pdfBytes.byteLength, expected: pdfAtt.size, head: new TextDecoder().decode(pdfBytes.subarray(0, 5)) };
      const { bundle, studies } = await C.searchStudies(d.imagingBase, token.patient, token.access_token);
      const retrieved: any[] = [];
      for (const s of studies) {
        for (const series of s.study.series) {
          const r = await C.wadoGet(`${s.wadoBase}/studies/${s.studyUID}/series/${series.uid}`, token.access_token);
          const hashes: string[] = [];
          for (const p of r.parts ?? []) hashes.push(await C.sha256Hex(p.bytes));
          retrieved.push({ study: s.studyUID, series: series.uid, status: r.status, hashes });
        }
      }
      return { token, patient, reports: reports.total, pdfFetch, total: bundle.total, entries: bundle.entry.length, studies: studies.map((s: any) => ({ uid: s.studyUID, wadoBase: s.wadoBase, nSeries: s.study.series.length })), retrieved };
    }, { clientId: CLIENT_ID, redirectUri: REDIRECT });

    check("token response has patient context", out.token.patient === PATIENT, out.token.patient);
    check("token response has a refresh token (offline_access)", typeof out.token.refresh_token === "string");
    check("token response scope", out.token.scope === FULL_SCOPE, out.token.scope);
    check("Patient read: name", out.patient.name?.[0]?.text === "Josh Example" && out.patient.birthDate === "1982-01-01" && out.patient.gender === "male" && out.patient.identifier?.[0]?.value === "JEXAMPLE01", out.patient.name);
    check(`DiagnosticReport search (category=RAD): one report per radiology study (${manifest.studies.length - 1})`, out.reports === manifest.studies.length - 1, out.reports);
    check("report PDF fetched cross-origin with the token", out.pdfFetch.status === 200 && out.pdfFetch.type === "application/pdf" && out.pdfFetch.size === out.pdfFetch.expected && out.pdfFetch.head === "%PDF-", out.pdfFetch);
    check("token response has token_type Bearer and scope", out.token.token_type === "Bearer" && typeof out.token.scope === "string");
    check(`ImagingStudy search: ${manifest.studies.length} studies + 1 included Endpoint`, out.total === manifest.studies.length && out.entries === manifest.studies.length + 1, { total: out.total, entries: out.entries });
    const allTruth = [...truthBySop.values()];
    let ok = 0;
    for (const r of out.retrieved) {
      const truth = (truthBySeries.get(r.series) ?? []).map((t) => t.sha).sort();
      if (r.status === 200 && JSON.stringify([...r.hashes].sort()) === JSON.stringify(truth)) ok += r.hashes.length;
    }
    check(`browser WADO-RS: ${ok}/${allTruth.length} instances (all series) match the built dataset by SHA-256`, ok === allTruth.length, out.retrieved.map((r: any) => [r.series.slice(-6), r.status, r.hashes.length]));
    return out.token as Record<string, any>;
  } finally {
    await browser.close();
  }
}

// ---------- main ----------

async function main() {
  await loadTruth();
  const app = Bun.serve({ port: APP_PORT, fetch: () => new Response("<!doctype html><title>Share (test stand-in)</title><p>app</p>", { headers: { "content-type": "text/html" } }) });
  running.push({ stop: () => app.stop(true) });
  if (remoteBase) CLIENT_ID = "imaging-sandbox-e2e"; // open registration; loopback redirect
  const brain = studyUIDById.get("mri-brain-2020")!;
  // The left wrist radiographs: three single-image series, stored as
  // Implicit VR Little Endian.
  const wrist = studyUIDById.get("xr-wrist-left-2012")!;
  const slide = studyUIDById.get("slide-lung-2023")!;
  const ALL = [...studyUIDById.values()];
  const N = ALL.length;
  console.log(`ground truth: ${truthBySop.size} instances in ${truthBySeries.size} series from ${DATASET}`);

  const bases: Record<Mode, string> = remoteBase
    ? { external: remoteBase, contained: "", capability: "" }
    : {
        external: await start(PORT_BASE, { ENDPOINT_MODE: "external" }),
        contained: await start(PORT_BASE + 1, { ENDPOINT_MODE: "contained" }),
        capability: await start(PORT_BASE + 2, { ENDPOINT_MODE: "capability" }),
      };
  const base = bases.external;

  // ---- browser flow ----
  const browserToken = await browserFlow(base);

  // ---- same token from Node: exact byte comparison, other retrievals ----
  section("WADO-RS retrieval in Node with the browser's token");
  const d = await C.discover(`${base}/fhir`);
  const at = browserToken.access_token as string;
  const { studies } = await C.searchStudies(d.imagingBase, PATIENT, at);
  await retrieveAndCompare("external Endpoint", studies, at, ALL);
  {
    const r = await fetch(`${studies[0].wadoBase}/studies/${brain}`, { headers: { authorization: `Bearer ${at}`, accept: C.DICOM_ACCEPT, "accept-encoding": "gzip, br" } });
    const body = new Uint8Array(await r.arrayBuffer());
    const parts = C.parseMultipart(body, r.headers.get("content-type") ?? "");
    check(`full brain study (${(body.byteLength / 1e6).toFixed(1)} MB multipart): 263 identical parts, no Content-Encoding`, r.status === 200 && !r.headers.get("content-encoding") && parts.length === 263 && parts.every((p) => { const t = truthBySop.get(str(parseDicom(p.bytes).dataset, 0x00080018)!); return !!t && sameBytes(t.bytes, p.bytes); }), { status: r.status, enc: r.headers.get("content-encoding"), n: parts.length });
    const cl = r.headers.get("content-length");
    check("multipart Content-Length matches the body", cl === null || Number(cl) === body.byteLength, cl);
  }
  const full = await C.wadoGet(`${studies[0].wadoBase}/studies/${wrist}`, at);
  check("full-study retrieval (wrist) returns 3 identical instances", full.status === 200 && full.parts!.length === 3 && full.parts!.every((p) => [...truthBySop.values()].some((t) => sameBytes(t.bytes, p.bytes))));
  const noTs = await fetch(`${studies[0].wadoBase}/studies/${wrist}`, { headers: { authorization: `Bearer ${at}`, accept: 'multipart/related; type="application/dicom"' } });
  const noTsBody = await noTs.text();
  check("Accept without transfer-syntax: 406 with an explanation", noTs.status === 406 && noTsBody.includes("transfer-syntax=*"), noTsBody);
  check("Accept */*: 406", (await status(`${base}/wado-rs/studies/${wrist}`, at, { headers: { accept: "*/*" } })) === 406);
  const explicitTs = await C.wadoGet(`${studies[0].wadoBase}/studies/${wrist}`, at, 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2');
  check("Accept with the stored transfer syntax UID (Implicit VR Little Endian): 200", explicitTs.status === 200 && explicitTs.parts?.length === 3);
  check("Accept with a transfer syntax the server does not store: 406", (await status(`${base}/wado-rs/studies/${wrist}`, at, { headers: { accept: 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1' } })) === 406);
  const sopT = truthBySeries.get([...truthBySeries.keys()].find((k) => truthBySeries.get(k)![0].studyUID === wrist)!)![0];
  const one = await C.wadoGet(`${base}/wado-rs/studies/${wrist}/series/${sopT.seriesUID}/instances/${sopT.sopUID}`, at);
  check("instance-level retrieval returns the identical instance", one.status === 200 && one.parts?.length === 1 && sameBytes(one.parts[0].bytes, sopT.bytes));
  const meta = await C.wadoGet(`${base}/wado-rs/studies/${brain}/metadata`, at, "application/dicom+json");
  check("study metadata: DICOM JSON for 263 instances", meta.status === 200 && Array.isArray(meta.json) && meta.json.length === 263 && meta.json[0]["0020000D"]?.Value?.[0] === brain);
  check("frames (not implemented): 404 after the token check", (await status(`${base}/wado-rs/studies/${wrist}/series/${sopT.seriesUID}/instances/${sopT.sopUID}/frames/1`, at)) === 404);

  section("Search parameters");
  const byId = await C.searchStudies(d.imagingBase, PATIENT, at, `&identifier=urn:oid:${wrist}`);
  check("identifier=urn:oid:{wrist} returns only the wrist study", byId.studies.length === 1 && byId.studies[0].studyUID === wrist);
  const byIdSys = await C.searchStudies(d.imagingBase, PATIENT, at, `&identifier=${encodeURIComponent(`urn:dicom:uid|urn:oid:${brain}`)}`);
  check("identifier=urn:dicom:uid|urn:oid:{brain} returns only the brain study", byIdSys.studies.length === 1 && byIdSys.studies[0].studyUID === brain);
  const future = await C.searchStudies(d.imagingBase, PATIENT, at, `&_lastUpdated=gt2099-01-01T00:00:00Z`);
  check("_lastUpdated=gt2099 returns no studies", future.bundle.total === 0);
  const past = await C.searchStudies(d.imagingBase, PATIENT, at, `&_lastUpdated=gt2000-01-01`);
  check("_lastUpdated=gt2000-01-01 returns every study", past.bundle.total === N);
  const viaRef = await C.fhirGet(`${d.imagingBase}/ImagingStudy?patient=Patient/${PATIENT}`, at);
  check("patient=Patient/{id} accepted", viaRef.total === N);
  const noInclude = await C.fhirGet(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, at);
  check("external mode without _include: no Endpoint entries", noInclude.entry.every((e: any) => e.resource.resourceType === "ImagingStudy"));

  section("Whole-slide (SM) study");
  {
    const slideStudy = studies.find((x) => x.studyUID === slide)!;
    const is = slideStudy.study;
    check("slide ImagingStudy: modality SM, 1 series, 5 instances", is.modality?.[0]?.code === "SM" && is.numberOfSeries === 1 && is.numberOfInstances === 5);
    check("slide ImagingStudy carries the CC BY attribution as a note", /CC BY 4\.0/.test(is.note?.[0]?.text ?? "") && /C3N-02231/.test(is.note[0].text));
    const meta = await C.wadoGet(`${slideStudy.wadoBase}/studies/${slide}/metadata`, at, "application/dicom+json");
    const types = (meta.json ?? []).map((m: any) => m["00080008"]?.Value?.[2]).sort();
    check("slide metadata: three VOLUME levels, OVERVIEW and THUMBNAIL", JSON.stringify(types) === JSON.stringify(["OVERVIEW", "THUMBNAIL", "VOLUME", "VOLUME", "VOLUME"]), types);
    const pyramid = new Set((meta.json ?? []).map((m: any) => m["00080019"]?.Value?.[0]));
    check("slide instances share one Pyramid UID", pyramid.size === 1 && ![...pyramid][0]?.startsWith("1.3.6.1.4.1.5962"));
    check("slide headers name the sample patient", (meta.json ?? []).every((m: any) => m["00100010"]?.Value?.[0]?.Alphabetic === "Example^Josh" && m["00100020"]?.Value?.[0] === "JEXAMPLE01" && m["00400512"]?.Value?.[0] === "EXSL2023-A1"));
  }

  section("Refresh and introspection");
  const refreshed = await C.refresh(d, { refreshToken: browserToken.refresh_token, clientId: CLIENT_ID });
  check("refresh_token grant issues a new access token with patient context", refreshed.access_token && refreshed.access_token !== at && refreshed.patient === PATIENT);
  check("refreshed token works for WADO-RS", (await status(`${base}/wado-rs/studies/${wrist}`, refreshed.access_token)) === 200);
  if (introspectionKey) {
    const intro = await fetch(`${base}/auth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${introspectionKey}` }, body: `token=${at}` }).then((r) => r.json());
    check("introspection: active, patient, scope, client_id", intro.active === true && intro.patient === PATIENT && intro.scope === FULL_SCOPE && intro.client_id === CLIENT_ID, intro);
    const bad = await fetch(`${base}/auth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${introspectionKey}` }, body: "token=nope" }).then((r) => r.json());
    check("introspection of an unknown token: active false", bad.active === false);
  }
  check("introspection without the resource-server key: 401", (await fetch(`${base}/auth/introspect`, { method: "POST", body: `token=${at}`, headers: { "content-type": "application/x-www-form-urlencoded" } })).status === 401);

  section("Token audience");
  if (introspectionKey) {
    const intro = await fetch(`${base}/auth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${introspectionKey}` }, body: `token=${at}` }).then((r) => r.json());
    check("introspection aud lists the clinical, imaging and WADO-RS bases", [`${base}/fhir`, `${base}/imaging/fhir`, `${base}/wado-rs`].every((b) => intro.aud?.includes(b)), intro.aud);
  }
  const sbx = sandboxes.get(base);
  if (sbx) {
    check("validator accepts the token at each of its bases", [`${base}/fhir`, `${base}/imaging/fhir`, `${base}/wado-rs`].every((b) => !!sbx.auth.validateAccessToken(at, b)));
    check("validator refuses the token at a base outside its aud", sbx.auth.validateAccessToken(at, "https://other.example/fhir") === null);
  }
  {
    // A launch that names the imaging base as aud still yields a token valid at all three servers.
    const { verifier, challenge } = await C.pkce();
    const dImg = { ...d, clinicalBase: d.imagingBase };
    let r = await fetch(C.authorizeUrl(dImg, { clientId: CLIENT_ID, redirectUri: REDIRECT, scope: FULL_SCOPE, state: "aud", challenge }), { redirect: "manual" });
    const request = (await r.text()).match(/name="request" value="([^"]+)"/)![1];
    const form = new URLSearchParams({ request, patient: PATIENT, decision: "allow" });
    for (const sc of FULL_SCOPE.split(" ")) form.append("scope", sc);
    for (const u of ALL) form.append("study", u);
    r = await fetch(`${base}/auth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    const tk = await C.exchangeCode(d, { code: new URL(r.headers.get("location")!).searchParams.get("code")!, verifier, clientId: CLIENT_ID, redirectUri: REDIRECT });
    check("aud=imaging base: token works at clinical, imaging and WADO-RS", (await status(`${base}/fhir/Patient/${PATIENT}`, tk.access_token)) === 200 && (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, tk.access_token)) === 200 && (await status(`${base}/wado-rs/studies/${wrist}`, tk.access_token)) === 200);
  }

  section("Imaging reports");
  const rad = await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}&category=${encodeURIComponent("http://terminology.hl7.org/CodeSystem/v2-0074|RAD")}`, at);
  check(`category=system|RAD: one report per radiology study (${N - 1})`, rad.total === N - 1);
  check("category=LAB: 0 reports", (await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}&category=LAB`, at)).total === 0);
  const byCode = await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}&code=${encodeURIComponent("http://loinc.org|37455-3")}`, at);
  check("code=http://loinc.org|37455-3: the left wrist report only", byCode.total === 1 && byCode.entry[0].resource.id === "report-xr-wrist-left-2012");
  const sp = await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}&category=SP`, at);
  check("category=SP: the slide's pathology report only", sp.total === 1 && sp.entry[0].resource.id === "report-slide-lung-2023" && sp.entry[0].resource.code.coding[0].code === "11529-5");
  const allReports = await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}`, at);
  check(`all reports: one per study (${N})`, allReports.total === N);
  for (const e of allReports.entry) {
    const r = e.resource;
    const studyId = r.id.replace(/^report-/, "");
    check(`${r.id}: read by id`, (await C.fhirGet(`${base}/fhir/DiagnosticReport/${r.id}`, at)).id === r.id);
    const ref = r.imagingStudy?.[0];
    check(`${r.id}: imagingStudy links its ImagingStudy by reference and Study Instance UID`, ref?.reference === `${d.imagingBase}/ImagingStudy/${studyId}` && ref?.identifier?.value === `urn:oid:${studyUIDById.get(studyId)}`);
    check(`${r.id}: category ${r.category[0].coding[0].code}, LOINC code, conclusion with the banner`, ["RAD", "SP"].includes(r.category[0].coding[0].code) && r.code.coding[0].system === "http://loinc.org" && r.conclusion.startsWith("SAMPLE REPORT FOR DEMONSTRATION. NOT A CLINICAL INTERPRETATION."));
    const pdfA = r.presentedForm.find((a: any) => a.contentType === "application/pdf");
    const txtA = r.presentedForm.find((a: any) => a.contentType.startsWith("text/plain"));
    const get = async (u: string) => { const res = await fetch(u, { headers: { authorization: `Bearer ${at}` } }); return { status: res.status, type: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) }; };
    const pdf = await get(pdfA.url);
    const txt = await get(txtA.url);
    const sha1 = (b: Uint8Array) => Buffer.from(new Bun.CryptoHasher("sha1").update(b).digest()).toString("base64");
    check(`${r.id}: PDF and text attachments fetchable, size and hash match`, pdf.status === 200 && txt.status === 200 && pdf.bytes.byteLength === pdfA.size && sha1(pdf.bytes) === pdfA.hash && sha1(txt.bytes) === txtA.hash);
    const pages = await pdfPages(pdf.bytes);
    const text = new TextDecoder().decode(txt.bytes);
    const norm = (x: string) => x.replace(/\s+/g, " ").trim();
    const BANNER = "SAMPLE REPORT FOR DEMONSTRATION. NOT A CLINICAL INTERPRETATION.";
    const pdfBody = pages.flatMap((p) => p.filter((l) => !l.includes(BANNER))).join("\n");
    const lines = text.split("\n");
    check(`${r.id}: PDF parses with PDF.js, every page has the banner, and its text matches the text attachment`, pages.length > 0 && pages.every((p) => p[0] === BANNER) && norm(pdfBody) === norm(lines.slice(2, lines.lastIndexOf(BANNER) - 1).join("\n")));
    check(`${r.id}: text names the sample patient and lists the study's series or instances`, text.includes("EXAMPLE, JOSH") && norm(text).includes("from the DICOM headers:"));
    const bin = await fetch(pdfA.url, { headers: { authorization: `Bearer ${at}`, accept: "application/fhir+json" } }).then((x) => x.json());
    check(`${r.id}: Binary as FHIR JSON when asked`, bin.resourceType === "Binary" && bin.contentType === "application/pdf" && Buffer.from(bin.data, "base64").byteLength === pdfA.size);
  }
  const brainPdfUrl = rad.entry.find((e: any) => e.resource.id === "report-mri-brain-2020").resource.presentedForm[0].url;
  check("report attachment without a token: 401", (await status(brainPdfUrl)) === 401);

  section("Negative: missing or bad token");
  check("ImagingStudy search, no token: 401", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`)) === 401);
  check("Patient read, no token: 401", (await status(`${base}/fhir/Patient/${PATIENT}`)) === 401);
  check("WADO-RS, no token: 401", (await status(`${base}/wado-rs/studies/${brain}`)) === 401);
  const r401 = await fetch(`${base}/wado-rs/studies/${brain}`);
  check("401 carries WWW-Authenticate: Bearer", (r401.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
  check("WADO-RS, made-up token: 401", (await status(`${base}/wado-rs/studies/${brain}`, "not-a-real-token")) === 401);

  section("Negative: token for another patient");
  const other = await httpLaunch(base, { patient: OTHER_PATIENT });
  check("other patient's token has its own patient context", other.token.patient === OTHER_PATIENT);
  check("search for the sample patient with robin's token: 403", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, other.token.access_token)) === 403);
  check("Patient read for the sample patient with robin's token: 403", (await status(`${base}/fhir/Patient/${PATIENT}`, other.token.access_token)) === 403);
  check("WADO-RS brain study with robin's token: 403", (await status(`${base}/wado-rs/studies/${brain}`, other.token.access_token)) === 403);
  check("WADO-RS brain series with robin's token: 403", (await status(`${base}/wado-rs/studies/${brain}/series/${[...truthBySeries.values()].find((t) => t[0].studyUID === brain)![0].seriesUID}`, other.token.access_token)) === 403);
  check("report attachment with robin's token: 404", (await status(brainPdfUrl, other.token.access_token)) === 404);
  const robinSearch = await C.fhirGet(`${d.imagingBase}/ImagingStudy?patient=${OTHER_PATIENT}`, other.token.access_token);
  check("robin's own search: 200 with no studies", robinSearch.total === 0);

  section("Negative: study not shared (user shared only the wrist)");
  const wristOnly = await httpLaunch(base, { studies: [wrist] });
  const wo = await C.searchStudies(d.imagingBase, PATIENT, wristOnly.token.access_token);
  check("search returns only the wrist study", wo.studies.length === 1 && wo.studies[0].studyUID === wrist);
  const woId = await C.searchStudies(d.imagingBase, PATIENT, wristOnly.token.access_token, `&identifier=urn:oid:${brain}`);
  check("identifier search for the unshared brain study: empty Bundle", woId.bundle.total === 0);
  check("WADO-RS brain study: 403", (await status(`${base}/wado-rs/studies/${brain}`, wristOnly.token.access_token)) === 403);
  check("WADO-RS brain metadata: 403", (await status(`${base}/wado-rs/studies/${brain}/metadata`, wristOnly.token.access_token, { headers: { accept: "application/dicom+json" } })) === 403);
  check("WADO-RS made-up study UID: 403 (same as unauthorized)", (await status(`${base}/wado-rs/studies/1.2.3.4`, wristOnly.token.access_token)) === 403);
  check("WADO-RS wrist study: 200", (await status(`${base}/wado-rs/studies/${wrist}`, wristOnly.token.access_token)) === 200);
  const woReports = await C.fhirGet(`${base}/fhir/DiagnosticReport?patient=${PATIENT}`, wristOnly.token.access_token);
  check("DiagnosticReport search returns only the wrist report", woReports.total === 1);
  check("brain report attachment with the wrist-only token: 404", (await status(brainPdfUrl, wristOnly.token.access_token)) === 404);
  const deniedUnshared = await fetch(`${base}/wado-rs/studies/${brain}`, { headers: { authorization: `Bearer ${wristOnly.token.access_token}`, accept: C.DICOM_ACCEPT } });
  const deniedUnknown = await fetch(`${base}/wado-rs/studies/1.2.3.4.5`, { headers: { authorization: `Bearer ${wristOnly.token.access_token}`, accept: C.DICOM_ACCEPT } });
  const [bodyU, bodyK] = [await deniedUnshared.text(), await deniedUnknown.text()];
  const hdrs = (r: Response) => JSON.stringify([...r.headers.entries()].filter(([k]) => !["date", "content-length"].includes(k)).sort());
  check("unshared and unknown studies: same status, headers and body", deniedUnshared.status === 403 && deniedUnknown.status === 403 && bodyU === bodyK && hdrs(deniedUnshared) === hdrs(deniedUnknown));

  section("Negative: wrong scopes");
  const patientOnly = await httpLaunch(base, { scope: "launch/patient patient/Patient.rs" });
  check("Patient-only token: Patient read 200", (await status(`${base}/fhir/Patient/${PATIENT}`, patientOnly.token.access_token)) === 200);
  check("Patient-only token: ImagingStudy search 403", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, patientOnly.token.access_token)) === 403);
  check("Patient-only token: WADO-RS 403", (await status(`${base}/wado-rs/studies/${wrist}`, patientOnly.token.access_token)) === 403);
  const r403 = await fetch(`${base}/wado-rs/studies/${wrist}`, { headers: { authorization: `Bearer ${patientOnly.token.access_token}`, accept: C.DICOM_ACCEPT } });
  check("403 carries error=insufficient_scope", (r403.headers.get("www-authenticate") ?? "").includes("insufficient_scope"));
  const searchOnly = await httpLaunch(base, { scope: "patient/ImagingStudy.s" });
  check("ImagingStudy.s token: search 200", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, searchOnly.token.access_token)) === 200);
  check("ImagingStudy.s token: WADO-RS 403 (retrieval needs r)", (await status(`${base}/wado-rs/studies/${wrist}`, searchOnly.token.access_token)) === 403);
  const readOnly = await httpLaunch(base, { scope: "patient/ImagingStudy.r" });
  check("ImagingStudy.r token: WADO-RS 200", (await status(`${base}/wado-rs/studies/${wrist}`, readOnly.token.access_token)) === 200);
  check("ImagingStudy.r token: search 403 (search needs s)", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, readOnly.token.access_token)) === 403);
  const v1 = await httpLaunch(base, { scope: "launch/patient patient/*.read" });
  check("SMART v1 patient/*.read token: search and WADO-RS work", (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, v1.token.access_token)) === 200 && (await status(`${base}/wado-rs/studies/${wrist}`, v1.token.access_token)) === 200);
  const deselected = await httpLaunch(base, { keepScopes: ["launch/patient", "patient/Patient.rs"] });
  check("user unticks ImagingStudy on the consent page: granted scope drops it", !deselected.token.scope.includes("ImagingStudy") && (await status(`${d.imagingBase}/ImagingStudy?patient=${PATIENT}`, deselected.token.access_token)) === 403);
  const systemOnly = await fetch(C.authorizeUrl(d, { clientId: CLIENT_ID, redirectUri: REDIRECT, scope: "system/ImagingStudy.rs", state: "s", challenge: (await C.pkce()).challenge }), { redirect: "manual" });
  check("system/ImagingStudy.rs only: invalid_scope (backend mode not offered)", new URL(systemOnly.headers.get("location")!).searchParams.get("error") === "invalid_scope");

  section("Negative: revocation");
  const rev = await httpLaunch(base, {});
  await fetch(`${base}/auth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rev.token.access_token, client_id: CLIENT_ID }) });
  check("revoked token: WADO-RS 401", (await status(`${base}/wado-rs/studies/${wrist}`, rev.token.access_token)) === 401);

  section("Negative: authorization request and token exchange");
  const pk = await C.pkce();
  const authz = (scope: string, extra: Record<string, string> = {}, drop: string[] = []) => {
    const u = new URL(C.authorizeUrl(d, { clientId: CLIENT_ID, redirectUri: REDIRECT, scope, state: "st", challenge: pk.challenge }));
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    for (const k of drop) u.searchParams.delete(k);
    return fetch(u, { redirect: "manual" });
  };
  const errOf = async (p: Promise<Response>) => { const r = await p; const l = r.headers.get("location"); return l ? new URL(l).searchParams.get("error") : `HTTP ${r.status}`; };
  check("authorize without code_challenge: invalid_request", (await errOf(authz(FULL_SCOPE, {}, ["code_challenge"]))) === "invalid_request");
  check("authorize with code_challenge_method=plain: invalid_request", (await errOf(authz(FULL_SCOPE, { code_challenge_method: "plain" }))) === "invalid_request");
  check("authorize with a wrong aud: invalid_request", (await errOf(authz(FULL_SCOPE, { aud: "https://elsewhere.example/fhir" }))) === "invalid_request");
  if (!remoteBase) check("authorize with an unregistered redirect_uri for the registered client: error page, no redirect", (await errOf(authz(FULL_SCOPE, { redirect_uri: `${APP_ORIGIN}/other` }))) === "HTTP 400");
  // Wrong verifier and code replay.
  {
    const { verifier, challenge } = await C.pkce();
    let r = await fetch(C.authorizeUrl(d, { clientId: CLIENT_ID, redirectUri: REDIRECT, scope: FULL_SCOPE, state: "x", challenge }), { redirect: "manual" });
    const request = (await r.text()).match(/name="request" value="([^"]+)"/)![1];
    const form = new URLSearchParams({ request, patient: PATIENT, decision: "allow", scope: "patient/ImagingStudy.rs" });
    r = await fetch(`${base}/auth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const wrong = await C.exchangeCode(d, { code, verifier: (await C.pkce()).verifier, clientId: CLIENT_ID, redirectUri: REDIRECT }).catch((e) => e.body);
    check("token exchange with the wrong code_verifier: invalid_grant", wrong.error === "invalid_grant", wrong);
    const good = await C.exchangeCode(d, { code, verifier, clientId: CLIENT_ID, redirectUri: REDIRECT }).catch((e) => e.body);
    check("token exchange with the right verifier still works after a failed attempt", typeof good.access_token === "string", good);
    const replay = await C.exchangeCode(d, { code, verifier, clientId: CLIENT_ID, redirectUri: REDIRECT }).catch((e) => e.body);
    check("code replay: invalid_grant", replay.error === "invalid_grant");
    check("code replay revokes the token issued from that code", (await status(`${base}/wado-rs/studies/${wrist}`, good.access_token)) === 401);
  }
  // Open client registration (sandbox default): any client_id with a loopback redirect.
  const open = await httpLaunch(base, { clientId: "some-other-app", redirectUri: "http://127.0.0.1:8123/cb" });
  check("unregistered client with a loopback redirect_uri (OPEN_CLIENTS): token issued", typeof open.token.access_token === "string");

  section("CORS");
  const pre = await fetch(`${base}/auth/token`, { method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  check("preflight to the token endpoint: 204 with Allow-Origin", pre.status === 204 && !!pre.headers.get("access-control-allow-origin"));
  const preW = await fetch(`${base}/wado-rs/studies/${wrist}`, { method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization, accept" } });
  check("preflight to WADO-RS allows the Authorization header", preW.status === 204 && /authorization/i.test(preW.headers.get("access-control-allow-headers") ?? ""));

  if (!remoteBase) {
    // ---- Endpoint forms ----
    for (const mode of ["contained", "capability"] as const) {
      section(`Endpoint form: ${mode}`);
      const L = await httpLaunch(bases[mode]);
      const dm = L.d;
      const res = await C.searchStudies(dm.imagingBase, PATIENT, L.token.access_token);
      const st = res.studies.find((s) => s.studyUID === wrist)!;
      if (mode === "contained") {
        check("ImagingStudy.endpoint references a contained Endpoint", res.bundle.entry.every((e: any) => e.resource.endpoint?.[0]?.reference === "#wado" && e.resource.contained?.[0]?.resourceType === "Endpoint"));
      } else {
        const noInc = await C.fhirGet(`${dm.imagingBase}/ImagingStudy?patient=${PATIENT}`, L.token.access_token);
        check("capability Endpoints are urn:uuid entries, present even without _include", noInc.entry.filter((e: any) => e.fullUrl.startsWith("urn:uuid:") && e.resource.resourceType === "Endpoint").length === N);
        check("capability addresses are distinct per study", new Set(res.studies.map((s) => s.wadoBase)).size === N && res.studies.every((s) => s.wadoBase.includes("/wado-rs/cap/")));
      }
      await retrieveAndCompare(mode, res.studies, L.token.access_token, ALL);
      if (mode === "capability") {
        const other2 = await httpLaunch(bases[mode]);
        check("capability URL with a different (valid) token: 403", (await status(`${st.wadoBase}/studies/${wrist}`, other2.token.access_token)) === 403);
        check("capability URL for the wrist with the brain study substituted: 403", (await status(`${st.wadoBase}/studies/${brain}`, L.token.access_token)) === 403);
        check("plain WADO-RS base still enforces the token: 200 for the same token", (await status(`${bases[mode].replace(/\/$/, "")}/wado-rs/studies/${wrist}`, L.token.access_token)) === 200);
      }
    }

    // ---- expiry ----
    section("Expiry and capabilities bound to the grant (ACCESS_TOKEN_TTL=2, CAPABILITY_TTL=5, capability mode, ALLOWED_ORIGINS list)");
    const short = await start(PORT_BASE + 3, { ENDPOINT_MODE: "capability", ACCESS_TOKEN_TTL: "2", CAPABILITY_TTL: "5", ALLOWED_ORIGINS: APP_ORIGIN });
    const t0 = Date.now();
    const S = await httpLaunch(short);
    const sres = await C.searchStudies(S.d.imagingBase, PATIENT, S.token.access_token);
    const capUrl = `${sres.studies.find((s) => s.studyUID === wrist)!.wadoBase}/studies/${wrist}`;
    check("capability URL works before expiry", (await status(capUrl, S.token.access_token)) === 200);
    const otherGrant = await httpLaunch(short);
    check("capability URL with another grant's valid token: 403", (await status(capUrl, otherGrant.token.access_token)) === 403);
    await Bun.sleep(2500);
    check("expired token: ImagingStudy search 401", (await status(`${S.d.imagingBase}/ImagingStudy?patient=${PATIENT}`, S.token.access_token)) === 401);
    check("expired token: WADO-RS 401", (await status(`${short}/wado-rs/studies/${wrist}`, S.token.access_token)) === 401);
    check("expired token: Patient read 401", (await status(`${short}/fhir/Patient/${PATIENT}`, S.token.access_token)) === 401);
    const intro = await fetch(`${short}/auth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${introspectionKey}` }, body: `token=${S.token.access_token}` }).then((r) => r.json());
    check("expired token: introspection active false", intro.active === false);
    const R = await C.refresh(S.d, { refreshToken: S.token.refresh_token, clientId: CLIENT_ID });
    check("capability URL survives a refresh: 200 with the refreshed token (same grant)", (await status(capUrl, R.access_token)) === 200);
    await Bun.sleep(Math.max(0, 5200 - (Date.now() - t0)));
    const R2 = await C.refresh(S.d, { refreshToken: S.token.refresh_token, clientId: CLIENT_ID });
    check("expired capability with a valid token: 403", (await status(capUrl, R2.access_token)) === 403);
    const again = await C.searchStudies(S.d.imagingBase, PATIENT, R2.access_token);
    const capUrl2 = `${again.studies.find((s) => s.studyUID === wrist)!.wadoBase}/studies/${wrist}`;
    check("re-search gives a working capability URL", (await status(capUrl2, R2.access_token)) === 200);
    // Revoking the refresh token revokes the grant: its tokens and capabilities stop working.
    const G = await httpLaunch(short);
    const gres = await C.searchStudies(G.d.imagingBase, PATIENT, G.token.access_token);
    const gcap = `${gres.studies.find((s) => s.studyUID === wrist)!.wadoBase}/studies/${wrist}`;
    await fetch(`${short}/auth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: G.token.refresh_token, client_id: CLIENT_ID }) });
    check("revoked grant: its access token gets 401 at the capability URL", (await status(gcap, G.token.access_token)) === 401);
    const refreshAfterRevoke = await C.refresh(G.d, { refreshToken: G.token.refresh_token, clientId: CLIENT_ID }).catch((e) => e.body);
    check("revoked grant: refresh refused", refreshAfterRevoke.error === "invalid_grant");
    const allowed = await fetch(`${short}/fhir/.well-known/smart-configuration`, { headers: { origin: APP_ORIGIN } });
    const denied = await fetch(`${short}/fhir/.well-known/smart-configuration`, { headers: { origin: "https://evil.example" } });
    check("ALLOWED_ORIGINS: listed origin echoed", allowed.headers.get("access-control-allow-origin") === APP_ORIGIN);
    check("ALLOWED_ORIGINS: other origin gets no Allow-Origin", denied.headers.get("access-control-allow-origin") === null);
  }

  for (const r of running) r.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); for (const r of running) r.stop(); process.exit(1); });
