// Creates fresh test links for the View checks and writes them to /tmp/view-fixtures.json.
// view-checks.mjs runs it at the start of every run and removes the shares at the end, so every
// run starts from unused links (passcode attempts, revocation).
//   bun web/checks/fixtures.ts [base]
//
//   publicLink, passcodeLink   the server's seeded sample links (right passcode only: wrong tries
//                              would use up the sample's attempts for everyone)
//   subsetLink                 the wrist study only
//   revokedLink, expiredLink   for the error screens
//   lockLinks.{desktop,phone}  passcode 2468, one per device, for the too-many-attempts screen
//   passcodeTestLink           passcode 1234, for wrong-passcode tries
//   perfLink                   synthetic 512² CT × 100 + 2048² DX (web/checks/synthetic.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { extractShlink, openShare, parseIndex } from "../core/index";
import { linksFor, packAndShare } from "./pack-share";
import { ctSeries, dxImage } from "./synthetic";

const base = process.argv[2] ?? "http://localhost:3333";
const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text()}`);
  return r.json();
};
const demos = (await j(await fetch(`${base}/api/demo-shares`))).shares;
const publicLink = extractShlink(demos.find((d: any) => !d.passcodeHint).shlinkUri)!;
const passcodeLink = extractShlink(demos.find((d: any) => d.passcodeHint).shlinkUri)!;

// A clone of the sample share (same encrypted files) with links of our own.
const cloned = await j(await fetch(`${base}/api/shares/${demos[0].id}/clone`, { method: "POST" }));
const links = linksFor(base, cloned.share.id, cloned.controlToken);
const sampleShare = await openShare(publicLink);
const bundle = sampleShare.index.bundle;
// What the checks expect of the sample, read from it rather than written into the checks.
const studies = sampleShare.index.studies;
const mri = studies.findIndex((s) => s.modalities.includes("MR"));
const sample = {
  label: sampleShare.resolver.label,
  studies: studies.length,
  mriStudy: mri,
  mriSeries: studies[mri].series.map((s) => s.description),
  wristStudy: studies.findIndex((s) => /extremity|wrist/i.test(s.description ?? "")),
  reports: sampleShare.index.reports.length,
};
// The first wrist study only (the sample may hold several).
const wristResource = bundle.entry.find((e: any) => e.resource?.resourceType === "ImagingStudy" && /extremity|wrist/i.test(e.resource.description ?? ""))?.resource;
const wristOnly = {
  ...bundle,
  entry: bundle.entry.filter((e: any) => e.resource?.resourceType !== "ImagingStudy" || e.resource === wristResource),
};
const subset = await links.mint(wristOnly, { label: "Wrist only" });
const revoked = await links.mint(bundle, { label: "Revoked test" });
await links.revoke(revoked.lid);
const expired = await links.mint(bundle, { label: "Expired test", exp: Math.floor(Date.now() / 1000) - 3600 });
const lockDesktop = await links.mint(bundle, { label: "Lockout test", passcode: "2468" });
const lockPhone = await links.mint(bundle, { label: "Lockout test", passcode: "2468" });
const passTest = await links.mint(bundle, { label: "Passcode test", passcode: "1234" });

// Reports from the imaging sandbox's clinical record (imaging-sandbox/build/dataset), added to the
// sample's Bundle as FHIR DiagnosticReports with their PDF and text inline, linked to the images
// each supported way: by imagingStudy (MRI, wrist), by accession only (CT), by date only (slide),
// and one that matches no study (a report from an exam that isn't in the share).
const reportsLink = await (async () => {
  const ds = new URL("../../imaging-sandbox/build/dataset/", import.meta.url).pathname;
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(`${ds}manifest.json`, "utf8"));
  } catch {
    return null; // sandbox data not built
  }
  const b64 = (p: string) => Buffer.from(readFileSync(`${ds}${p}`)).toString("base64");
  // Every ImagingStudy entry gets a fullUrl (the sample's may already have one).
  for (const e of bundle.entry) if (e.resource?.resourceType === "ImagingStudy") e.fullUrl ??= `urn:uuid:${crypto.randomUUID()}`;
  const entryOf = (uid: string) => bundle.entry.find((e: any) => e.resource?.resourceType === "ImagingStudy" && (e.resource.identifier ?? []).some((i: any) => i.value === `urn:oid:${uid}`));
  const report = (st: any, how: "fullUrl" | "relative" | "uid" | "accession" | "date" | "none") => {
    const r = st.report;
    const dr: any = {
      resourceType: "DiagnosticReport",
      id: `rep-${st.id}`,
      status: "final",
      code: { coding: [r.code], text: r.title },
      conclusion: r.conclusion,
      presentedForm: r.attachments.map((a: any) => ({ contentType: a.contentType, data: b64(a.path), size: a.size, title: r.title })),
    };
    if (r.category) dr.category = [{ coding: [r.category], text: r.category.display }];
    if (how !== "none") dr.effectiveDateTime = st.studyDate;
    if (how === "uid") dr.imagingStudy = [{ identifier: { system: "urn:dicom:uid", value: `urn:oid:${st.studyInstanceUID}` } }];
    if (how === "fullUrl") dr.imagingStudy = [{ reference: entryOf(st.studyInstanceUID)?.fullUrl }];
    if (how === "relative") dr.imagingStudy = [{ reference: `ImagingStudy/${entryOf(st.studyInstanceUID)?.resource.id}` }];
    if (how !== "date" && how !== "none")
      dr.identifier = [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] }, value: st.accession }];
    if (how === "none") {
      dr.id = "rep-not-shared";
      dr.effectiveDateTime = "2019-03-02";
      dr.code = { text: "XR CHEST 2 VIEWS" };
    }
    return { fullUrl: `urn:uuid:${crypto.randomUUID()}`, resource: dr };
  };
  const by = (id: string) => manifest.studies.find((s: any) => s.id === id);
  const plan: [string, "fullUrl" | "relative" | "uid" | "accession" | "date" | "none"][] = [
    ["mri-brain-2020", "uid"],
    ["xr-hand-wrist-right-2012", "fullUrl"],
    ["xr-wrist-left-2012", "relative"],
    ["ct-abdomen-pelvis-2012", "accession"],
    ["slide-lung-2023", "date"],
    ["xr-hand-right-2012", "none"],
  ];
  const entries = plan.filter(([id]) => by(id)?.report).map(([id, how]) => report(by(id), how));
  const withReports = { ...bundle, entry: [...bundle.entry.filter((e: any) => e.resource?.resourceType !== "DiagnosticReport"), ...entries] };
  const mri = by("mri-brain-2020")?.report?.attachments.find((a: any) => a.contentType.startsWith("text/plain"));
  return {
    link: (await links.mint(withReports, { label: "Images and reports" })).shlink,
    // The MRI report's text attachment, for checking that it is shown as is.
    mriText: mri ? readFileSync(`${ds}${mri.path}`, "utf8") : "",
  };
})();

// Synthetic CT and DX, packed and uploaded as the Share page does.
const ct = ctSeries();
const perfShare = await packAndShare(base, [...ct.map((b, i) => ({ name: `ct${i}.dcm`, bytes: b })), { name: "dx.dcm", bytes: dxImage() }]);
const perf = await perfShare.mint(perfShare.bundle, { label: "Synthetic CT and DX (timing)" });

const out = {
  sample,
  publicLink,
  passcodeLink,
  subsetLink: subset.shlink,
  revokedLink: revoked.shlink,
  expiredLink: expired.shlink,
  lockLinks: { desktop: lockDesktop.shlink, phone: lockPhone.shlink },
  passcodeTestLink: passTest.shlink,
  reportsLink: reportsLink?.link ?? null,
  reportsMriText: reportsLink?.mriText ?? "",
  perfLink: perf.shlink,
  // Positions in the perf link's overview (studies are ordered by date, then UID: look them up).
  perfCtStudy: (await parseIndex(perfShare.bundle)).studies.findIndex((s) => s.modalities.includes("CT")),
  perfDxStudy: (await parseIndex(perfShare.bundle)).studies.findIndex((s) => s.modalities.includes("DX")),
  // DELETE these after the run.
  shares: [
    { sid: cloned.share.id, token: cloned.controlToken },
    { sid: perfShare.sid, token: perfShare.token },
  ],
};
writeFileSync("/tmp/view-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, shares: out.shares.map((s) => s.sid) }, null, 2));
