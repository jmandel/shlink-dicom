// Builds the GitHub Pages site: a copy of the viewer and one SMART Health Link served from static
// files (spec/README.md §10, U mode), into dist/pages:
//
//   index.html                 about this copy, the demo link and its QR code (pages/index.html)
//   view/index.html, assets/   the viewer, as web/build.ts builds it (run that first)
//   config.json                the viewer's sample link (web/core/config.ts)
//   demo-links/{segment}/bundle.jwe      the link's encrypted Bundle ({segment}: 256 random bits)
//   demo-links/{segment}/{fileId}.bin    one encrypted file per study
//
// The link's input, keys and hashes are in pages/demo-link.json. The DICOM files are fetched from
// my-health-data at the pinned commit, re-encoded without loss (JPEG Lossless SV1) and packed with
// the given keys by shl-dicom-server (`compress`, `pack --keys`), so every build makes the same
// files and the link never changes. The build fails if an input, a study file's plaintext or
// ciphertext, or the Bundle differs from the recorded hashes: a file key must never encrypt
// different bytes (spec/README.md §13).
//
//   bun pages/build.ts [--out dist/pages] [--site-url URL] [--new-keys]
//
//   --site-url   build for another address (local checks); the link then differs from the recorded one
//   --new-keys   after changing the input: draw a new link key, IV, file ids and file keys, and
//                record them and the new hashes in pages/demo-link.json
//
// Needs dist/web (bun web/build.ts) and the server binary ($SHL_DICOM_SERVER, else
// $CARGO_TARGET_DIR or target/release/shl-dicom-server).
import { $ } from "bun";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import qrcode from "qrcode-generator";
import { fetchPinned } from "../deploy/lib/pinned-fetch";
import { parseStudyIndex, type StudyIndex } from "../web/core/bundle";
import { planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT } from "../web/core/range";

const root = resolve(import.meta.dir, "..");
const configPath = join(root, "pages/demo-link.json");
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = resolve(opt("--out") ?? join(root, "dist/pages"));
const newKeys = args.includes("--new-keys");
const server =
  process.env.SHL_DICOM_SERVER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/shl-dicom-server");
const work = `${out}.work`;
/** The full demo, with the server. */
const LIVE = "https://shlink-dicom.exe.xyz";
const cache = resolve(process.env.PAGES_SOURCE_CACHE ?? join(root, "dist/pages-sources"));

interface StudyConfig {
  description: string;
  studyInstanceUid: string;
  fileId: string;
  key: string;
  plaintextSha256: string;
  ciphertextSha256: string;
}
interface Config {
  _comment: string[];
  siteUrl: string;
  label: string;
  link: string;
  shlKey: string;
  bundleIv: string;
  /** The link's folder under demo-links/: 32 random bytes as base64url, so the link's url carries
   * the 256 bits of entropy the SHL specification requires. */
  segment: string;
  lastUpdated: string;
  bundleSha256: string;
  source: { repo: string; commit: string; files: { path: string; sha256: string }[] };
  studies: StudyConfig[];
}

const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Config;
const siteUrl = opt("--site-url") ?? cfg.siteUrl;
if (newKeys && opt("--site-url")) throw new Error("--new-keys records the link for the configured siteUrl; leave out --site-url");
if (!/^https?:\/\/.+\/$/.test(siteUrl)) throw new Error(`site URL must end in "/": ${siteUrl}`);
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fail = (msg: string): never => {
  console.error(`pages/build.ts: ${msg}`);
  process.exit(1);
};
// A recorded value must match; with --new-keys an empty one is recorded.
const check = (what: string, recorded: string, actual: string, set: (v: string) => void) => {
  if (recorded === actual) return;
  if (newKeys && !recorded) return set(actual);
  fail(
    `${what} is ${actual}, but pages/demo-link.json records ${recorded || "nothing"}. If the input changed on purpose, ` +
      "run bun pages/build.ts --new-keys (new keys and file ids; the link changes).",
  );
};

if (!newKeys && !/^[A-Za-z0-9_-]{43}$/.test(cfg.segment ?? "")) fail("pages/demo-link.json records no link folder (segment): run bun pages/build.ts --new-keys (the link changes)");
if (!existsSync(join(root, "dist/web/view/index.html"))) fail("dist/web missing: run bun web/build.ts first");
if (!existsSync(server)) fail(`${server} missing: cargo build --release -p shl-dicom-server`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

if (newKeys) {
  cfg.shlKey = b64url(randomBytes(32));
  cfg.bundleIv = b64url(randomBytes(12));
  cfg.segment = b64url(randomBytes(32));
  cfg.lastUpdated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  cfg.bundleSha256 = "";
  cfg.link = "";
  for (const f of cfg.source.files) f.sha256 = "";
}

// 1. The input, at the pinned commit.
const inputs: string[] = [];
for (const f of cfg.source.files) {
  const url = `https://raw.githubusercontent.com/${cfg.source.repo}/${cfg.source.commit}/${f.path}`;
  const keep = join(cache, cfg.source.commit);
  const bytes = await fetchPinned({ url, sha256: f.sha256, name: f.path }, { keep }).catch((e) =>
    fail(`${(e as Error).message}. If the input changed on purpose, run bun pages/build.ts --new-keys (new keys and file ids; the link changes).`),
  );
  check(`SHA-256 of ${f.path}`, f.sha256, sha256(bytes), (v) => (f.sha256 = v));
  inputs.push(join(keep, f.path));
}
console.log(`input: ${inputs.length} files from ${cfg.source.repo}@${cfg.source.commit.slice(0, 12)}, hashes match`);

// 2. Lossless re-encoding, as the live sample and the Share page do.
await $`${server} compress ${inputs} --out ${join(work, "plain")}`;

// 3. Pack with the recorded keys (with --new-keys: new ones, for the studies a first pack finds).
if (newKeys) {
  await $`${server} pack ${join(work, "plain")} --out ${join(work, "probe")}`.quiet();
  const probe = parseStudyIndex(readFileSync(join(work, "probe/bundle.json")));
  cfg.studies = probe.studies.map((s) => ({
    description: s.description ?? "",
    studyInstanceUid: s.studyInstanceUid,
    fileId: b64url(randomBytes(16)),
    key: b64url(randomBytes(32)),
    plaintextSha256: "",
    ciphertextSha256: "",
  }));
}
writeFileSync(
  join(work, "keys.json"),
  JSON.stringify({
    shlKey: cfg.shlKey,
    bundleIv: cfg.bundleIv,
    segment: cfg.segment,
    lastUpdated: cfg.lastUpdated,
    studies: Object.fromEntries(cfg.studies.map((s) => [s.studyInstanceUid, { fileId: s.fileId, key: s.key }])),
  }),
);
const packDir = join(work, "pack");
const packed = await $`${server} pack ${join(work, "plain")} --out ${packDir} --keys ${join(work, "keys.json")} --base-url ${siteUrl}demo-links/ --label ${cfg.label}`.text();
const link = /^(shlink:\/\S+)$/m.exec(packed)?.[1] ?? fail(`no link in pack output:\n${packed}`);

// 4. Check the Bundle and every study file against the recorded hashes.
const bundleJson = readFileSync(join(packDir, "bundle.json"));
const index: StudyIndex = parseStudyIndex(bundleJson);
check("SHA-256 of the Bundle", cfg.bundleSha256, sha256(bundleJson), (v) => (cfg.bundleSha256 = v));
for (const st of cfg.studies) {
  const entry = index.studies.find((s) => s.studyInstanceUid === st.studyInstanceUid) ?? fail(`study ${st.studyInstanceUid} not packed`);
  const file = entry.files[0];
  if (entry.files.length !== 1 || file.fileId !== st.fileId || file.key !== st.key) fail(`study ${st.studyInstanceUid}: unexpected file in the Bundle`);
  const ct = readFileSync(join(packDir, cfg.segment, `${st.fileId}.bin`));
  if (ct.length !== file.ciphertextLength) fail(`${st.fileId}.bin: ${ct.length} bytes, the Bundle says ${file.ciphertextLength}`);
  // Decrypt record by record (§9.2) to hash the plaintext.
  const key = Buffer.from(st.key, "base64url");
  const plain = createHash("sha256");
  for (let i = 0; i * RECORD_CIPHERTEXT < ct.length; i++) {
    const rec = ct.subarray(i * RECORD_CIPHERTEXT, Math.min(ct.length, (i + 1) * RECORD_CIPHERTEXT));
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(i, 8);
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(rec.subarray(rec.length - 16));
    plain.update(d.update(rec.subarray(0, rec.length - 16)));
    d.final();
  }
  check(`plaintext SHA-256 of ${st.description}`, st.plaintextSha256, plain.digest("hex"), (v) => (st.plaintextSha256 = v));
  check(`ciphertext SHA-256 of ${st.description}`, st.ciphertextSha256, sha256(ct), (v) => (st.ciphertextSha256 = v));
}
if (index.studies.length !== cfg.studies.length) fail(`${index.studies.length} studies packed, ${cfg.studies.length} recorded`);
if (opt("--site-url")) console.log(`--site-url: link for ${siteUrl} (the recorded link is for ${cfg.siteUrl})`);
else check("The link", cfg.link, link, (v) => (cfg.link = v));
if (newKeys) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log("recorded new keys and hashes in pages/demo-link.json");
}
console.log("study files, Bundle and link match pages/demo-link.json");

// 5. The site.
rmSync(out, { recursive: true, force: true });
const linkDir = `demo-links/${cfg.segment}`;
mkdirSync(join(out, linkDir), { recursive: true });
const web = join(root, "dist/web");
// Pages compresses on its own and ignores the .br and .gz copies.
cpSync(join(web, "assets"), join(out, "assets"), { recursive: true, filter: (p) => !/\.(br|gz)$/.test(p) });
const replaceOnce = (html: string, from: string, to: string, file: string) => {
  if (html.split(from).length !== 2) fail(`${file}: expected "${from}" once`);
  return html.replace(from, to);
};
let viewHtml = readFileSync(join(web, "view/index.html"), "utf8");
// This copy has no How it works page and no server sample: point at the full site and this link.
viewHtml = replaceOnce(viewHtml, 'href="../how"', `href="${LIVE}/how"`, "view/index.html");
viewHtml = replaceOnce(
  viewHtml,
  "The de-identified studies of Josh Example, and a lung slide shared under CC BY.",
  "Josh Example’s brain MRI and left wrist X-rays, de-identified.",
  "view/index.html",
);
mkdirSync(join(out, "view"), { recursive: true });
writeFileSync(join(out, "view/index.html"), viewHtml);
writeFileSync(join(out, "config.json"), JSON.stringify({ viewerPrefix: `${siteUrl}view/`, sampleLink: link }) + "\n");
cpSync(join(packDir, cfg.segment, "bundle.jwe"), join(out, linkDir, "bundle.jwe"));
for (const st of cfg.studies) cpSync(join(packDir, cfg.segment, `${st.fileId}.bin`), join(out, linkDir, `${st.fileId}.bin`));

// The entry page, with this build's numbers.
const viewerLink = `${siteUrl}view/#${link}`;
const qr = qrcode(0, "M");
qr.addData(viewerLink);
qr.make();
const mri = index.studies.find((s) => s.modalities.includes("MR")) ?? fail("no MR study");
const xr = index.studies.find((s) => s !== mri) ?? fail("no X-ray study");
const t2 = mri.series.find((s) => s.number === 16) ?? fail("MRI series 16 missing");
const slice = t2.instances.findIndex((i) => i.number === 11);
if (slice < 0) fail("MRI series 16 instance 11 missing");
const plan = planInstances(t2, slice);
const mb = (n: number) => (n / 1e6).toFixed(1);
const fmt = (n: number) => n.toLocaleString("en-US");
const vars: Record<string, string> = {
  LINK: link,
  LINK_DIR: linkDir,
  VIEWER_LINK: viewerLink,
  QR: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }),
  BUNDLE_KB: String(Math.round(statSync(join(out, linkDir, "bundle.jwe")).size / 1000)),
  MRI_SERIES: String(mri.numberOfSeries),
  MRI_INSTANCES: String(mri.numberOfInstances),
  MRI_MB: mb(mri.files[0].ciphertextLength),
  MRI_FILE: `${mri.files[0].fileId}.bin`,
  MRI_RECORDS: fmt(mri.files[0].recordCount),
  XR_SERIES: String(xr.numberOfSeries),
  XR_MB: mb(xr.files[0].ciphertextLength),
  SLICE_SERIES: `${t2.number}, ${t2.description}`,
  SLICE_N: `${slice + 1} of ${t2.instances.length}`,
  SLICE_KB: String(Math.round(t2.instances[slice].length / 1000)),
  SLICE_OFFSET: fmt(t2.instances[slice].offset),
  SLICE_RECORDS: `${plan.firstRecord}–${plan.lastRecord}`,
  SLICE_RECORD_COUNT: String(plan.lastRecord - plan.firstRecord + 1),
  SLICE_RANGE: plan.rangeHeader,
  RECORD_PLAINTEXT: fmt(RECORD_PLAINTEXT),
  SITE_URL: siteUrl,
  SOURCE_COMMIT: cfg.source.commit,
  SOURCE_COMMIT_SHORT: cfg.source.commit.slice(0, 7),
};
const page = readFileSync(join(root, "pages/index.html"), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => vars[k] ?? fail(`pages/index.html: no value for {{${k}}}`));
writeFileSync(join(out, "index.html"), page);
cpSync(join(root, "pages/pages.css"), join(out, "assets/pages.css"));
rmSync(work, { recursive: true, force: true });

const sizes = readdirSync(join(out, linkDir)).map((f) => `  ${linkDir}/${f}  ${fmt(statSync(join(out, linkDir, f)).size)} B`);
console.log(`site: ${out}\n${sizes.join("\n")}\nlink: ${viewerLink}`);
