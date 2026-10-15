// Checks the built dataset.
//
//   bun test/data-check.ts
//
// 1. Determinism: builds the dataset twice into test/.work and compares
//    every file's SHA-256.
// 2. Pixel data: for every source instance (extracted with the system
//    `tar`), the built file's Pixel Data element is byte-identical, the
//    transfer syntax is the same, and every top-level element the rewrite
//    does not target is byte-identical too.
// 3. Headers: the fictional patient, dates and accession are set, sex is
//    left as the source had it, and no original UID survives.
// 4. Reports: each PDF parses with PDF.js (and passes `qpdf --check` when
//    qpdf is installed), every page carries the sample banner, and the PDF
//    text equals the text/plain attachment.

import { mkdirSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDicom, str } from "../src/dicom.ts";
import { pixelDataElement } from "../scripts/lib/dicom-rewrite.ts";
import { pdfPages } from "./pdf-text.ts";
import { BANNER } from "../scripts/lib/report.ts";

const ROOT = resolve(import.meta.dir, "..");
const WORK = join(import.meta.dir, ".work", "data-check");
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`); }
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

console.log("Determinism");
for (const run of ["a", "b"]) {
  const p = Bun.spawnSync(["bun", join(ROOT, "scripts/build-data.ts"), "--out", join(WORK, run), "--export", join(WORK, `${run}-export`), "--quiet"], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`build ${run} failed`);
}
const sumsA = readFileSync(join(WORK, "a/SHA256SUMS"), "utf8");
const sumsB = readFileSync(join(WORK, "b/SHA256SUMS"), "utf8");
check(`two builds produce identical bytes (${sumsA.trim().split("\n").length} files)`, sumsA === sumsB);
const verify = Bun.spawnSync(["sha256sum", "--quiet", "-c", "SHA256SUMS"], { cwd: join(WORK, "a") });
check("SHA256SUMS matches the files on disk", verify.exitCode === 0, verify.stdout.toString());
{
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const hashes = (d: string) => walk(d).map((f) => `${f.slice(d.length)} ${new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex")}`).sort().join("\n");
  check("two builds produce identical exports", hashes(join(WORK, "a-export")) === hashes(join(WORK, "b-export")));
  const served = new Set(sumsA.trim().split("\n").filter((l) => l.includes(" dicom/")).map((l) => l.split(" ")[0]));
  const exported = walk(join(WORK, "a-export", "dicom")).map((f) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex"));
  check(`export: ${exported.length} DICOM files, byte-identical to the served files`, exported.length === served.size && exported.every((h) => served.has(h)));
}
console.log(`  SHA-256 of SHA256SUMS: ${new Bun.CryptoHasher("sha256").update(sumsA).digest("hex")}`);

const DS = join(WORK, "a");
const manifest = JSON.parse(readFileSync(join(DS, "manifest.json"), "utf8"));
const studiesCfg = JSON.parse(readFileSync(join(ROOT, "data/studies.json"), "utf8"));
const patient = manifest.patient;

console.log("\nPixel data and untouched elements");
const REWRITTEN = new Set([0x00080020, 0x00080023, 0x00080030, 0x00080033, 0x00080050, 0x00100010, 0x00100020, 0x00100030, 0x00120062]);
const allOriginalUids = new Set<string>();
let compared = 0, pixelSame = 0, tsSame = 0, othersSame = 0;
for (const st of manifest.studies) {
  const src = studiesCfg.sources.find((s: any) => s.archive === st.archive);
  const local = [join(ROOT, "build/sources", st.archive), join(ROOT, "../data/samples", st.archive)].find(existsSync)!;
  const dir = join(WORK, "src", st.archive);
  mkdirSync(dir, { recursive: true });
  check(`${st.archive}: source matches the pinned SHA-256`, new Bun.CryptoHasher("sha256").update(readFileSync(local)).digest("hex") === src.sha256);
  Bun.spawnSync(["tar", "-xzf", local, "-C", dir]);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const byOrig = new Map<string, any>(st.files.map((f: any) => [f.originalSopInstanceUID, f]));
  for (const f of walk(dir).filter((x) => x.endsWith(".dcm"))) {
    const before = new Uint8Array(readFileSync(f));
    const pb = parseDicom(before, { stopAtPixelData: false });
    const sop = str(pb.dataset, 0x00080018)!;
    for (const t of [0x00080018, 0x0020000d, 0x0020000e, 0x00200052]) { const v = str(pb.dataset, t); if (v) allOriginalUids.add(v); }
    const built = byOrig.get(sop);
    if (!built) { check(`${f}: present in the build`, false); continue; }
    const after = new Uint8Array(readFileSync(join(DS, built.path)));
    const pa = parseDicom(after, { stopAtPixelData: false });
    compared++;
    if (Buffer.compare(pixelDataElement(before), pixelDataElement(after)) === 0) pixelSame++;
    if (pa.transferSyntaxUID === pb.transferSyntaxUID) tsSame++;
    const same = pb.dataset.filter((e) => !REWRITTEN.has(e.tag) && e.vr !== "UI" && !e.items).every((e) => {
      const a = pa.dataset.find((x) => x.tag === e.tag);
      return a && Buffer.compare(before.subarray(e.start, e.end), after.subarray(a.start, a.end)) === 0;
    });
    if (same) othersSame++;
  }
}
check(`Pixel Data element byte-identical for ${pixelSame}/${compared} instances`, compared === 266 && pixelSame === compared);
check(`transfer syntax unchanged for ${tsSame}/${compared} instances`, tsSame === compared);
check(`every other non-UID top-level element byte-identical for ${othersSame}/${compared} instances`, othersSame === compared);

console.log("\nHeaders");
let headerOk = 0, total = 0, leaked = 0;
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
for (const st of manifest.studies) {
  for (const f of st.files) {
    total++;
    const bytes = new Uint8Array(readFileSync(join(DS, f.path)));
    const d = parseDicom(bytes).dataset;
    const ok =
      str(d, 0x00100010) === patient.dicomName &&
      str(d, 0x00100020) === patient.mrn &&
      str(d, 0x00100030) === patient.birthDate.replace(/-/g, "") &&
      str(d, 0x00100040) === undefined &&
      str(d, 0x00080020) === st.studyDate.replace(/-/g, "") &&
      str(d, 0x00080030) === st.studyTime.replace(/:/g, "") &&
      str(d, 0x00080050) === st.accession &&
      str(d, 0x0020000d) === st.studyInstanceUID &&
      str(d, 0x00080018) === f.sopInstanceUID &&
      !d.some((e) => e.tag === 0x00120062);
    if (ok) headerOk++;
    const text = latin1(bytes);
    for (const u of allOriginalUids) if (text.includes(u)) { leaked++; break; }
  }
}
check(`patient, dates, accession and UIDs set in ${headerOk}/${total} files (sex left empty, as in the source)`, headerOk === total);
check("no original Study, Series, SOP Instance or Frame of Reference UID appears in any built file", leaked === 0, leaked);
check("brain MRI keeps its 29 Jul 2020 date", manifest.studies.find((s: any) => s.id === "mri-brain-2020").studyDate === "2020-07-29");

console.log("\nReports");
for (const st of manifest.studies) {
  const pdfAtt = st.report.attachments.find((a: any) => a.contentType === "application/pdf");
  const txtAtt = st.report.attachments.find((a: any) => a.contentType.startsWith("text/plain"));
  const pdf = new Uint8Array(readFileSync(join(DS, pdfAtt.path)));
  const txt = readFileSync(join(DS, txtAtt.path), "utf8");
  if (Bun.which("qpdf")) {
    const q = Bun.spawnSync(["qpdf", "--check", join(DS, pdfAtt.path)]);
    check(`${st.id}: qpdf --check passes`, q.exitCode === 0, q.stdout.toString());
  }
  const pages = await pdfPages(pdf);
  check(`${st.id}: PDF.js opens the PDF (${pages.length} page${pages.length === 1 ? "" : "s"})`, pages.length >= 1);
  check(`${st.id}: every PDF page carries the banner at top and bottom`, pages.every((p) => p[0] === BANNER && p[p.length - 1].includes(BANNER) && /Page \d+ of \d+/.test(p[p.length - 1])));
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const pdfBody = pages.flatMap((p) => p.filter((l) => !l.includes(BANNER)));
  const txtLines = txt.split("\n");
  const txtBody = txtLines.slice(2, txtLines.lastIndexOf(BANNER) - 1);
  check(`${st.id}: text/plain starts and ends with the banner`, txtLines[0] === BANNER && txtLines.includes(BANNER, 1));
  check(`${st.id}: PDF text equals the text/plain report`, norm(pdfBody.join("\n")) === norm(txtBody.join("\n")), { pdf: norm(pdfBody.join(" ")).slice(0, 200), txt: norm(txtBody.join(" ")).slice(0, 200) });
  check(`${st.id}: conclusion carries the banner and the impression`, st.report.conclusion.startsWith(BANNER) && txt.includes(st.report.conclusion.split("impression: ")[1]));
}

rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
