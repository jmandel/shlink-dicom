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
// 3. Headers: the sample patient, study date and accession match the
//    manifest, and no original UID of a rewritten study survives.
// 4. Reports: each PDF parses with PDF.js (and passes `qpdf --check` when
//    qpdf is installed), every page carries the synthetic-report footer, and the PDF
//    text equals the text/plain attachment.

import { mkdirSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDicom, str } from "../src/dicom.ts";
import { pixelDataElement, samePixelFrames, basicOffsets, basicOffsetTableValid } from "../scripts/lib/dicom-rewrite.ts";
import { pdfPages } from "./pdf-text.ts";
import { loadStore } from "../src/data.ts";
import { loadConfig } from "../src/config.ts";
import { diagnosticReport, imagingStudy, serviceRequestResource } from "../src/fhir.ts";
import { FOOTER } from "../scripts/lib/report.ts";

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
  const p = Bun.spawnSync(["bun", join(ROOT, "scripts/build-data.ts"), "--out", join(WORK, run), "--export", join(WORK, `${run}-export`), "--no-variants", "--quiet"], { stdout: "inherit", stderr: "inherit" });
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
const BASE_REWRITTEN = [0x00080020, 0x00080023, 0x00080030, 0x00080033, 0x00080050, 0x00100010, 0x00100020, 0x00100030, 0x00120062];
const ID_UID_TAGS = [0x00080017, 0x00080018, 0x00080019, 0x0020000d, 0x0020000e, 0x00200052, 0x00209164, 0x00400554];
const allOriginalUids = new Set<string>();
const cacheDirs = (process.env.SOURCE_CACHE ?? "").split(":").filter(Boolean);
const findLocal = (name: string) => [join(ROOT, "build/sources", name), join(ROOT, "../data/samples", name), ...cacheDirs.map((d) => join(d, name))].find(existsSync)!;
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
const collectUids = (els: any[]) => { for (const e of els) { if (e.items) e.items.forEach(collectUids); else if (ID_UID_TAGS.includes(e.tag)) { const v = str([e], e.tag); if (v) allOriginalUids.add(v); } } };
let compared = 0, pixelSame = 0, pixelBot = 0, tsSame = 0, othersSame = 0, servedAsIs = 0, servedAsIsSame = 0;
const botPairs: { before: string; after: string; frames: number }[] = [];
for (const st of manifest.studies) {
  const cfgStudy = studiesCfg.studies.find((x: any) => x.id === st.id);
  const h = cfgStudy.header ?? {};
  const rewritten = new Set([...BASE_REWRITTEN, ...Object.keys(h.set ?? {}).map((t) => parseInt(t, 16)), ...(h.remove ?? []).map((t: string) => parseInt(t, 16))]);
  const removedGroups = new Set((h.removeGroups ?? []).map((g: string) => parseInt(g, 16)));
  const names: string[] = st.archive ? [st.archive] : st.sources;
  const sourceFiles: string[] = [];
  for (const name of names) {
    const src = studiesCfg.sources.find((s: any) => s.archive === name);
    const local = findLocal(name);
    check(`${name}: source matches the pinned SHA-256`, new Bun.CryptoHasher("sha256").update(readFileSync(local)).digest("hex") === src.sha256);
    if (name.endsWith(".tgz")) {
      const dir = join(WORK, "src", name);
      mkdirSync(dir, { recursive: true });
      Bun.spawnSync(["tar", "-xzf", local, "-C", dir]);
      sourceFiles.push(...walk(dir).filter((x) => x.endsWith(".dcm")));
    } else sourceFiles.push(local);
  }
  const byOrig = new Map<string, any>(st.files.map((f: any) => [f.originalSopInstanceUID, f]));
  for (const f of sourceFiles) {
    const before = new Uint8Array(readFileSync(f));
    const pb = parseDicom(before, { stopAtPixelData: false });
    const sop = str(pb.dataset, 0x00080018)!;
    if (st.rewritten) collectUids(pb.dataset);
    const built = byOrig.get(sop);
    if (!built) { check(`${f}: present in the build`, false); continue; }
    const after = new Uint8Array(readFileSync(join(DS, built.path)));
    if (!st.rewritten) { servedAsIs++; if (Buffer.compare(before, after) === 0) servedAsIsSame++; }
    const pa = parseDicom(after, { stopAtPixelData: false });
    compared++;
    const hasPixels = pb.dataset.some((e) => e.tag === 0x7fe00010);
    if (!hasPixels) { if (Buffer.compare(before, after) === 0) pixelSame++; } // e.g. the dose SR
    else if (Buffer.compare(pixelDataElement(before), pixelDataElement(after)) === 0) pixelSame++;
    else if (samePixelFrames(before, after)) {
      pixelBot++;
      botPairs.push({ before: f, after: join(DS, built.path), frames: Number(str(pa.dataset, 0x00280008)) });
    }
    if (pa.transferSyntaxUID === pb.transferSyntaxUID) tsSame++;
    const replaced = new Set(Object.keys(h.replaceStrings ?? {}));
    const same = pb.dataset
      .filter((e) => e.tag !== 0x7fe00010 && !rewritten.has(e.tag) && !removedGroups.has(e.tag >>> 16) && e.vr !== "UI" && !e.items && !replaced.has(str([e], e.tag) ?? "\0"))
      .every((e) => {
        const a = pa.dataset.find((x) => x.tag === e.tag);
        return a && Buffer.compare(before.subarray(e.start, e.end), after.subarray(a.start, a.end)) === 0;
      });
    if (same) othersSame++;
  }
}
const expectedInstances = manifest.studies.reduce((n: number, st: any) => n + st.files.length, 0);
check(`Pixel Data: element byte-identical for ${pixelSame} instances, fragments identical with a filled Basic Offset Table for ${pixelBot}; ${pixelSame + pixelBot}/${compared} in all`, compared === expectedInstances && pixelSame + pixelBot === compared);
check("Basic Offset Table filled exactly for the multi-frame slide levels (3), nowhere else", pixelBot === 3 && botPairs.every((b) => b.after.includes("/slide-lung-2023/") && b.frames > 1));
check(`transfer syntax unchanged for ${tsSame}/${compared} instances`, tsSame === compared);
check(`every other non-UID top-level element byte-identical for ${othersSame}/${compared} instances`, othersSame === compared);
check(`studies served unchanged (the de-identified my-health-data archives): ${servedAsIsSame}/${servedAsIs} files byte-identical to the source archives`, servedAsIs > 0 && servedAsIsSame === servedAsIs);

console.log("\nOffset tables");
{
  const has = (cmd: string) => Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0;
  const py = process.env.PYDICOM_PYTHON ?? "python3";
  const pydicomOk = Bun.spawnSync([py, "-I", "-c", "import pydicom"]).exitCode === 0;
  const decoder = process.env.SHL_DICOM_DECODE ?? join(ROOT, "../codecs/target/coord/release/shl-dicom-decode");
  for (const b of botPairs) {
    const label = `${b.frames}-frame level`;
    const after = new Uint8Array(readFileSync(b.after));
    const offs = basicOffsets(after);
    check(`${label}: BOT has ${offs.length} 32-bit entries, each pointing at its frame's first fragment item`, offs.length === b.frames && basicOffsetTableValid(after));
    check(`${label}: no Extended Offset Table`, !parseDicom(after, { stopAtPixelData: false }).dataset.some((e) => e.tag === 0x7fe00001));
    if (has("dcmdump")) {
      const out = Bun.spawnSync(["dcmdump", "-q", b.after]);
      const items = [...out.stdout.toString().matchAll(/^\s+\(fffe,e000\) pi .*#\s*(\d+),/gm)].map((m) => Number(m[1]));
      check(`${label}: dcmdump reads the pixel items (BOT of ${4 * b.frames} bytes + ${b.frames} fragments)`, out.exitCode === 0 && items.length === b.frames + 1 && items[0] === 4 * b.frames, { exit: out.exitCode, n: items.length, bot: items[0] });
    }
    if (pydicomOk) {
      const r = Bun.spawnSync([py, "-I", join(import.meta.dir, "check-frames.py"), b.after, b.before]);
      const j = JSON.parse(r.stdout.toString() || "{}");
      check(`${label}: pydicom get_frame through the BOT reads every frame, equal to the source (${j.equal}/${j.frames})`, r.exitCode === 0 && j.bot === b.frames && j.equal === b.frames && j.source_frames === b.frames, r.stderr.toString().slice(-300));
    } else console.log("  skip pydicom checks (set PYDICOM_PYTHON to a Python with pydicom)");
    if (has("dcmj2pnm")) {
      const picks = [0, 1, Math.floor(b.frames / 2), b.frames - 1].map((i) => i + 1);
      let same = 0;
      for (const k of picks) {
        const run = (f: string, o: string) => Bun.spawnSync(["dcmj2pnm", "-q", "--frame", String(k), "--write-raw-pnm", f, o]).exitCode;
        const oa = join(WORK, "a.pnm"), ob = join(WORK, "b.pnm");
        if (run(b.before, ob) === 0 && run(b.after, oa) === 0 && Buffer.compare(readFileSync(oa), readFileSync(ob)) === 0) same++;
      }
      check(`${label}: dcmtk decodes frames ${picks.join(", ")} identically from the source and the rewritten file`, same === picks.length, same);
    }
    if (existsSync(decoder) && b.frames <= 300) {
      const oa = join(WORK, "a.raw"), ob = join(WORK, "b.raw");
      const ra = Bun.spawnSync([decoder, b.after, oa]), rb = Bun.spawnSync([decoder, b.before, ob]);
      const h = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
      check(`${label}: shl-dicom-decode output of all frames identical for the source and the rewritten file`, ra.exitCode === 0 && rb.exitCode === 0 && h(oa) === h(ob), (ra.stderr.toString() + rb.stderr.toString()).slice(-300));
    }
  }
}

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
      str(d, 0x00080020) === st.studyDate.replace(/-/g, "") &&
      str(d, 0x00080050) === st.accession &&
      str(d, 0x0020000d) === st.studyInstanceUID &&
      str(d, 0x00080018) === f.sopInstanceUID &&
      !d.some((e) => e.tag === 0x00120062);
    if (ok) headerOk++;
    const pix = parseDicom(bytes, { stopAtPixelData: false }).dataset.find((e) => e.tag === 0x7fe00010);
    const text = latin1(bytes.subarray(0, pix ? pix.start : bytes.length)); // UIDs live in the header
    for (const u of allOriginalUids) if (text.includes(u)) { leaked++; break; }
  }
}
check(`patient (${patient.dicomName}, ${patient.mrn}, born ${patient.birthDate}), study date, accession and UIDs match the manifest in ${headerOk}/${total} files`, headerOk === total);
check(`none of the ${allOriginalUids.size} original instance-identifying UIDs (Study, Series, SOP Instance, Frame of Reference, Pyramid, Acquisition, Dimension Organization, Specimen) appears in any built file`, leaked === 0, leaked);
{
  // Source identifiers of the slide (CPTAC subject and specimen) must be gone from every header.
  let found = 0;
  for (const st of manifest.studies) for (const f of st.files) {
    const b = new Uint8Array(readFileSync(join(DS, f.path)));
    const pe = parseDicom(b, { stopAtPixelData: false }).dataset.find((e) => e.tag === 0x7fe00010);
    const hdr = latin1(b.subarray(0, pe ? pe.start : b.length));
    if (["C3N-02231", "CPTAC", "LUAD", ".svs", "Anonymized"].some((w) => hdr.includes(w))) found++;
  }
  check("no source subject, specimen, collection or file names left in any header", found === 0, found);
}
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
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const isFooter = (l: string) => l.includes(FOOTER) || /^Page \d+ of \d+$/.test(l.trim());
  check(`${st.id}: every PDF page ends with the synthetic-report footer and a page number`, pages.every((p) => p[p.length - 1].includes(FOOTER) && /Page \d+ of \d+/.test(p[p.length - 1])));
  const pdfBody = pages.flatMap((p) => p.filter((l) => !isFooter(l)));
  const txtBody = txt.split("\n").filter((l) => l.trim() !== FOOTER);
  check(`${st.id}: the text/plain report ends with the footer`, txt.trimEnd().endsWith(FOOTER));
  check(`${st.id}: PDF text equals the text/plain report`, norm(pdfBody.join("\n")) === norm(txtBody.join("\n")), { pdf: norm(pdfBody.join(" ")).slice(0, 300), txt: norm(txtBody.join(" ")).slice(0, 300) });
  check(`${st.id}: letterhead, patient block and signature present`, txt.includes("EXAMPLE, JOSH") && txt.includes(`MRN: ${patient.mrn}`) && txt.includes(`Date of birth: ${patient.birthDate}`) && txt.includes("Electronically signed"));
  check(`${st.id}: conclusion is the report's impression or diagnosis`, norm(txt).includes(norm(st.report.conclusion.split(". ")[0])));
}

console.log("\nLossless compressed copies (transfer syntax negotiation)");
{
  const VDIR = resolve(process.env.VARIANTS_DIR ?? join(ROOT, "build/variants"));
  const vmPath = join(VDIR, "manifest.json");
  if (!existsSync(vmPath)) {
    check("compressed copies present (run bun scripts/build-data.ts without --no-variants)", false);
  } else {
    const vm = JSON.parse(readFileSync(vmPath, "utf8"));
    const live = join(ROOT, "build/dataset");
    const liveManifest = JSON.parse(readFileSync(join(live, "manifest.json"), "utf8"));
    const SV1 = "1.2.840.10008.1.2.4.70", J2K = "1.2.840.10008.1.2.4.90";
    const UNC = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"]);
    const byPath = new Map<string, any>(vm.instances.map((e: any) => [e.source, e]));
    let uncompressed = 0, complete = 0, fresh = 0;
    const sizes = new Map<string, { stored: number; uncompressed: number; sv1: number; j2k: number }>();
    for (const st of liveManifest.studies) {
      const z = { stored: 0, uncompressed: 0, sv1: 0, j2k: 0 };
      for (const f of st.files) {
        z.stored += f.size;
        const b = new Uint8Array(readFileSync(join(live, f.path)));
        const p = parseDicom(b);
        if (!UNC.has(p.transferSyntaxUID) || !p.dataset.some((e) => e.tag === 0x00280010)) continue;
        uncompressed++;
        z.uncompressed += f.size;
        const e = byPath.get(f.path);
        if (e && e.sourceSha256 === f.sha256) fresh++;
        const sv1 = e?.variants.find((v: any) => v.ts === SV1 && v.size), j2k = e?.variants.find((v: any) => v.ts === J2K && v.size);
        if (sv1 && j2k) { complete++; z.sv1 += sv1.size; z.j2k += j2k.size; }
      }
      sizes.set(st.id, z);
    }
    check(`every uncompressed image (${uncompressed}) has an SV1 and a J2K copy made from the current file; no failures`, complete === uncompressed && fresh === uncompressed && vm.failures.length === 0, { complete, fresh, failures: vm.failures.length });
    for (const [id, z] of sizes) console.log(`  ${id.padEnd(26)} stored ${(z.stored / 1e6).toFixed(1).padStart(6)} MB; uncompressed images ${(z.uncompressed / 1e6).toFixed(1).padStart(6)} MB -> SV1 ${(z.sv1 / 1e6).toFixed(1).padStart(5)} MB, J2K ${(z.j2k / 1e6).toFixed(1).padStart(5)} MB`);
    // Pixel identity through an independent decoder (the copies were made by dcmtk and OpenJPEG).
    const decoder = process.env.SHL_DICOM_DECODE ?? join(ROOT, "../codecs/target/coord/release/shl-dicom-decode");
    if (existsSync(decoder)) {
      const h = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
      let same = 0, n = 0;
      const bad: string[] = [];
      for (const e of vm.instances) {
        const r0 = Bun.spawnSync([decoder, join(live, e.source), join(WORK, "s.raw")]);
        if (r0.exitCode !== 0) { bad.push(e.source); continue; }
        const ref = h(join(WORK, "s.raw"));
        for (const v of e.variants.filter((x: any) => x.size)) {
          n++;
          const r = Bun.spawnSync([decoder, join(VDIR, v.path), join(WORK, "v.raw")]);
          if (r.exitCode === 0 && h(join(WORK, "v.raw")) === ref) same++;
          else bad.push(v.path);
        }
      }
      check(`shl-dicom-decode decodes every copy to the stored image's pixels (${same}/${n})`, same === n && n === 2 * uncompressed, bad.slice(0, 3));
    } else console.log("  skip decoder check (set SHL_DICOM_DECODE)");
  }
}

console.log("\nReport-to-study links");
{
  // Build the FHIR resources the server serves, from the dataset just checked.
  const cfg = loadConfig({ BASE_URL: "https://sandbox.example", DATASET_DIR: DS });
  const store = await loadStore(DS, join(ROOT, "data/test-patients.json"));
  const ACSN = (ids: any[]) => ids.filter((i) => i.type?.coding?.some((c: any) => c.system === "http://terminology.hl7.org/CodeSystem/v2-0203" && c.code === "ACSN"));
  const studies = [...store.studies.values()];
  let matched = 0;
  for (const st of studies) {
    const dr: any = diagnosticReport(cfg, st);
    const is: any = imagingStudy(cfg, st, "Endpoint/wado-rs");
    const sr: any = serviceRequestResource(cfg, st);
    const enc = store.clinical.encounters.find((e) => e.id === st.clinical?.encounter)!;
    const target = studies.filter((x) => `${cfg.baseUrl}/imaging/fhir/ImagingStudy/${x.id}` === dr.imagingStudy?.[0]?.reference);
    const drAcc = ACSN(dr.identifier), isAcc = ACSN(is.identifier), srAcc = ACSN(sr.identifier);
    const uidRef = dr.imagingStudy?.[0]?.identifier?.value;
    // Every DICOM instance of the study (originals, reconstructions, dose SR) agrees.
    const dicomOk = st.series.every((se) => se.instances.every((i) => str(i.header, 0x00080050) === st.accession && str(i.header, 0x0020000d) === st.uid && str(i.header, 0x00080020) === st.started!.slice(0, 10).replace(/-/g, "")));
    const t = (x: string) => Date.parse(x);
    const ok =
      target.length === 1 && target[0] === st &&
      drAcc.length === 1 && drAcc[0].value === st.accession && isAcc.length === 1 && isAcc[0].value === st.accession && srAcc.length === 1 && srAcc[0].value === st.accession &&
      drAcc[0].system === isAcc[0].system && drAcc[0].system === srAcc[0].system && drAcc[0].system.endsWith(`/${enc.organization}/accession`) &&
      uidRef === `urn:oid:${st.uid}` && is.identifier.some((i: any) => i.system === "urn:dicom:uid" && i.value === `urn:oid:${st.uid}`) &&
      dr.basedOn?.[0]?.reference === `ServiceRequest/${sr.id}` && is.basedOn?.[0]?.reference === `${cfg.baseUrl}/fhir/ServiceRequest/${sr.id}` &&
      dr.effectiveDateTime === st.started && is.started === st.started && sr.occurrenceDateTime === st.started &&
      t(sr.authoredOn) <= t(st.started!) && t(st.started!) < t(dr.issued) &&
      t(enc.start) <= t(st.started!) && t(st.started!) <= t(enc.end) &&
      dr.encounter?.reference === `Encounter/${enc.id}` && sr.encounter?.reference === `Encounter/${enc.id}` &&
      dicomOk;
    if (ok) matched++;
    else console.log(`  mismatch in ${st.id}:`, { target: target.map((x) => x.id), drAcc, isAcc, srAcc, uidRef, dicomOk, effective: dr.effectiveDateTime, started: st.started, issued: dr.issued, enc: [enc.start, enc.end] });
  }
  check(`every report's imagingStudy, accession (ACSN, same system on report, study and order), Study UID, order, encounter and times point at one study, consistent with its DICOM: ${matched}/${studies.length}`, matched === studies.length && studies.length === manifest.studies.length);
  const reports = studies.map((st) => diagnosticReport(cfg, st) as any);
  const unmatched = reports.filter((r) => !studies.some((st) => r.imagingStudy?.[0]?.identifier?.value === `urn:oid:${st.uid}`));
  check("no report is left without its study, and no study without a report", unmatched.length === 0 && new Set(reports.map((r) => r.imagingStudy[0].reference)).size === studies.length);
}

rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
