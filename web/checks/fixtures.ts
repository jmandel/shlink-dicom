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
import { writeFileSync } from "node:fs";
import { extractShlink, openShare } from "../core/index";
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
  perfLink: perf.shlink,
  // DELETE these after the run.
  shares: [
    { sid: cloned.share.id, token: cloned.controlToken },
    { sid: perfShare.sid, token: perfShare.token },
  ],
};
writeFileSync("/tmp/view-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, shares: out.shares.map((s) => s.sid) }, null, 2));
