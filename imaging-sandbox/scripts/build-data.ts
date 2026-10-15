// Builds the sandbox's served dataset from committed config.
//
//   bun scripts/build-data.ts [--out build/dataset] [--sources build/sources]
//
// 1. Fetches the sources, pinned by URL and SHA-256 (data/studies.json):
//    the de-identified "Josh Example" studies from github.com/jmandel/
//    my-health-data (imaging/) and the CC BY slide from the NCI Imaging
//    Data Commons. A local copy with the right hash (build/sources/,
//    ../data/samples/, or a SOURCE_CACHE directory) is used instead of
//    downloading.
// 2. Studies marked "rewrite": false (the my-health-data studies) are
//    served unchanged, after checking they carry the patient in
//    data/patient.json. The slide's headers are rewritten to that patient,
//    with new deterministic UIDs and a filled Basic Offset Table; the
//    build fails if any frame's data or transfer syntax differs from the
//    source.
// 3. Generates a sample report per study (PDF and plain text).
// 4. Writes everything, with manifest.json and SHA256SUMS, to --out, and a
//    plain per-study export of the DICOM files and reports to --export.
//
// The output depends only on the pinned sources, the config and this code,
// so two runs produce identical bytes (checked by test/data-check.ts).

import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { readTgz } from "../src/tar.ts";
import { parseDicom, str, int } from "../src/dicom.ts";
import { rewriteDicom, samePixelFrames, mintUid, type HeaderSet } from "./lib/dicom-rewrite.ts";
import { reportLines, reportText, conclusion, BANNER, type ReportInput } from "./lib/report.ts";
import { buildPdf } from "./lib/pdf.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : dflt);
const OUT = arg("--out", join(ROOT, "build/dataset"));
const SOURCES = arg("--sources", join(ROOT, "build/sources"));
// Plain export of the rewritten files for other consumers (the shlink-dicom
// sample share): <export>/dicom/<study>/<series>/<instance>.dcm, plus the
// reports and an index. "--export none" skips it.
const EXPORT = args.includes("--export") && args[args.indexOf("--export") + 1] === "none" ? null : arg("--export", join(ROOT, "out"));
const quiet = args.includes("--quiet");
const log = (...a: unknown[]) => { if (!quiet) console.log(...a); };

interface StudyConfig {
  id: string;
  rewrite?: boolean; // false: serve the source files unchanged (already de-identified)
  archives?: string[]; // .tgz sources holding the study's .dcm files
  archive?: string; // a single .tgz source
  files?: string[]; // or individual .dcm sources (by source archive name)
  accession?: string; // with rewrite: values written into the headers;
  studyDate?: string; // without: read from the headers
  studyTime?: string;
  utcOffset?: string;
  attribution?: string;
  header?: {
    set?: Record<string, [string, string]>;
    remove?: string[];
    removeGroups?: string[];
    replaceStrings?: Record<string, string>;
  };
  report: ReportInput & { category?: { system: string; code: string; display: string } };
}

const patient = JSON.parse(await Bun.file(join(ROOT, "data/patient.json")).text());
const cfg = JSON.parse(await Bun.file(join(ROOT, "data/studies.json")).text()) as {
  uidNamespace: string;
  sources: { archive: string; url: string; sha256: string }[];
  removeTags: { tags: string[] };
  studies: StudyConfig[];
};

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const sha1b64 = (b: Uint8Array) => Buffer.from(new Bun.CryptoHasher("sha1").update(b).digest()).toString("base64");

async function source(archive: string): Promise<Uint8Array> {
  const s = cfg.sources.find((x) => x.archive === archive);
  if (!s) throw new Error(`no source for ${archive}`);
  // SOURCE_CACHE: extra directories (colon-separated) searched by file name
  // before downloading; a file is used only if its SHA-256 matches the pin.
  const cache = (process.env.SOURCE_CACHE ?? "").split(":").filter(Boolean).map((d) => join(d, archive));
  for (const candidate of [join(SOURCES, archive), join(ROOT, "../data/samples", archive), ...cache]) {
    if (existsSync(candidate)) {
      const b = new Uint8Array(await Bun.file(candidate).arrayBuffer());
      if (sha256(b) === s.sha256) { log(`source ${archive}: ${relative(process.cwd(), candidate)} (hash ok)`); return b; }
    }
  }
  log(`source ${archive}: downloading ${s.url}`);
  const res = await fetch(s.url);
  if (!res.ok) throw new Error(`download ${s.url}: HTTP ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  if (sha256(b) !== s.sha256) throw new Error(`${archive}: SHA-256 ${sha256(b)} does not match the pinned ${s.sha256}`);
  mkdirSync(dirname(join(SOURCES, archive)), { recursive: true });
  writeFileSync(join(SOURCES, archive), b);
  return b;
}

const compact = (d: string) => d.replace(/-/g, "");
const compactTime = (t: string) => t.replace(/:/g, "");
const mapUid = (u: string) => mintUid(cfg.uidNamespace, u);
const removeTags = new Set(cfg.removeTags.tags.map((t) => parseInt(t, 16)));

const tmp = `${OUT}.tmp`;
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const write = (rel: string, bytes: Uint8Array | string) => {
  const f = join(tmp, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, bytes);
  return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
};

const manifestStudies: unknown[] = [];
const exportFiles: { from: string; to: string }[] = [];
for (const st of cfg.studies) {
  const tgzs = st.archives ?? (st.archive ? [st.archive] : []);
  const entries = tgzs.length
    ? (await Promise.all(tgzs.map(async (a) => readTgz(await source(a))))).flat().filter((e) => e.path.toLowerCase().endsWith(".dcm"))
    : await Promise.all((st.files ?? []).map(async (name) => ({ path: name, bytes: await source(name) })));
  const rewrite = st.rewrite !== false;
  if (!rewrite) {
    // Read the study's date, time and accession number from its headers.
    const d0 = parseDicom(entries[0].bytes).dataset;
    const da = str(d0, 0x00080020) ?? "", tm = str(d0, 0x00080030) ?? "";
    st.studyDate = `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
    st.studyTime = tm ? `${tm.slice(0, 2)}:${tm.slice(2, 4)}:${tm.slice(4, 6) || "00"}` : undefined;
    st.accession = str(d0, 0x00080050) ?? "";
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const set = new Map<number, HeaderSet>([
    [0x00080020, { vr: "DA", value: compact(st.studyDate!) }],
    [0x00080023, { vr: "DA", value: compact(st.studyDate!) }],
    [0x00080030, { vr: "TM", value: compactTime(st.studyTime ?? "") }],
    [0x00080033, { vr: "TM", value: compactTime(st.studyTime ?? "") }],
    [0x00080050, { vr: "SH", value: st.accession! }],
    [0x00100010, { vr: "PN", value: patient.dicomName }],
    [0x00100020, { vr: "LO", value: patient.mrn }],
    [0x00100030, { vr: "DA", value: compact(patient.birthDate) }],
  ]);
  for (const [tag, [vr, value]] of Object.entries(st.header?.set ?? {})) set.set(parseInt(tag, 16), { vr, value });
  const remove = new Set([...removeTags, ...(st.header?.remove ?? []).map((t) => parseInt(t, 16))]);
  const removeGroups = new Set((st.header?.removeGroups ?? []).map((g) => parseInt(g, 16)));
  const replaceStrings = new Map(Object.entries(st.header?.replaceStrings ?? {}));

  const files: { path: string; size: number; sha256: string; sopInstanceUID: string; originalSopInstanceUID: string; seriesInstanceUID: string }[] = [];
  const series = new Map<string, { number?: number; description: string; images: number; unit?: [string, string] }>();
  const seriesUIDs = new Set<string>();
  let magnification = "";
  let studyUID = "", originalStudyUID = "", manufacturer = "", model = "", field = "";
  for (const e of entries) {
    const before = parseDicom(e.bytes, { stopAtPixelData: false });
    const out = rewrite ? rewriteDicom(e.bytes, { set, remove, removeGroups, replaceStrings, mapUid, fillBasicOffsetTable: true }) : e.bytes;
    const after = parseDicom(out, { stopAtPixelData: false });
    // Checks: pixel data and transfer syntax untouched, values applied.
    if (!samePixelFrames(e.bytes, out)) throw new Error(`${e.path}: Pixel Data frames changed`);
    if (after.transferSyntaxUID !== before.transferSyntaxUID) throw new Error(`${e.path}: transfer syntax changed`);
    const d = after.dataset;
    if (str(d, 0x00100010) !== patient.dicomName || str(d, 0x00100020) !== patient.mrn || str(d, 0x00080050) !== st.accession) throw new Error(`${e.path}: patient or accession does not match`);
    const origSop = str(before.dataset, 0x00080018)!;
    const sop = str(d, 0x00080018)!;
    if ((rewrite && sop !== mapUid(origSop)) || str(after.meta, 0x00020003) !== sop) throw new Error(`${e.path}: SOP Instance UID mismatch`);
    originalStudyUID = str(before.dataset, 0x0020000d)!;
    studyUID = str(d, 0x0020000d)!;
    const seriesUID = str(d, 0x0020000e)!;
    manufacturer = str(d, 0x00080070) ?? manufacturer;
    model = str(d, 0x00081090) ?? model;
    field = str(d, 0x00180087) ?? field;
    if (str(d, 0x00080060) === "SM") {
      // Slide microscopy: one technique line per instance (pyramid level).
      const type = (str(d, 0x00080008) ?? "").split("\\")[2] ?? "IMAGE";
      const frames = int(d, 0x00280008) ?? 1;
      const u32 = (tag: number) => { const el = d.find((x) => x.tag === tag); return el ? new DataView(el.value.buffer, el.value.byteOffset).getUint32(0, true) : undefined; };
      const w = u32(0x00480006), h = u32(0x00480007);
      series.set(sop, {
        number: int(d, 0x00200013),
        description: `${type}${w && h ? ` ${w} x ${h}` : ""}`,
        images: type === "VOLUME" ? frames : 1,
        unit: type === "VOLUME" ? ["tile", "tiles"] : ["image", "images"],
      });
      seriesUIDs.add(seriesUID);
    } else {
      const s = series.get(seriesUID) ?? { number: int(d, 0x00200011), description: str(d, 0x0008103e) ?? "", images: 0 };
      s.images++;
      series.set(seriesUID, s);
      seriesUIDs.add(seriesUID);
    }
    if (str(d, 0x00080060) === "SM") {
      const op = d.find((x) => x.tag === 0x00480105)?.items?.[0]?.find((x) => x.tag === 0x00480112);
      if (op) magnification = `${Number(str([op], 0x00480112))}x objective`;
    }
    const rel = `dicom/${st.id}/${seriesUID}/${sop}.dcm`;
    write(rel, out);
    const seriesNo = String(int(d, 0x00200011) ?? 0).padStart(3, "0");
    const seriesName = (str(d, 0x0008103e) ?? "series").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    exportFiles.push({ from: rel, to: `dicom/${st.id}/S${seriesNo}-${seriesName}/IM${String(int(d, 0x00200013) ?? 0).padStart(4, "0")}-${sop.slice(-8)}.dcm` });
    files.push({ path: rel, size: out.byteLength, sha256: sha256(out), sopInstanceUID: sop, originalSopInstanceUID: origSop, seriesInstanceUID: seriesUID });
  }

  // Report.
  const equipment = [manufacturer, model].filter(Boolean).join(" ") + (field ? `, ${Number(field)} T` : "") + (magnification ? `, ${magnification}` : "");
  const lines = reportLines(st.report, {
    patientName: `${patient.family.toUpperCase()}, ${patient.given.join(" ").toUpperCase()}`,
    birthDate: patient.birthDate,
    mrn: patient.mrn,
    accession: st.accession,
    examDateTime: `${st.studyDate}${st.studyTime ? " " + st.studyTime.slice(0, 5) : ""}`,
    equipment,
    series: [...series.values()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9)),
  });
  const text = reportText(lines);
  const pdf = buildPdf({ title: `Sample radiology report: ${st.report.title}`, banner: BANNER, lines });
  const att = (path: string, bytes: Uint8Array, contentType: string) => ({ path, contentType, size: bytes.byteLength, sha1: sha1b64(bytes), sha256: sha256(bytes) });
  exportFiles.push({ from: `reports/${st.id}.pdf`, to: `reports/${st.id}.pdf` }, { from: `reports/${st.id}.txt`, to: `reports/${st.id}.txt` });
  const pdfAtt = att(`reports/${st.id}.pdf`, write(`reports/${st.id}.pdf`, pdf), "application/pdf");
  const txtAtt = att(`reports/${st.id}.txt`, write(`reports/${st.id}.txt`, text), "text/plain; charset=utf-8");

  manifestStudies.push({
    id: st.id,
    sources: tgzs.length ? tgzs : st.files,
    rewritten: rewrite,
    ...(st.attribution ? { attribution: st.attribution } : {}),
    studyInstanceUID: studyUID,
    originalStudyInstanceUID: originalStudyUID,
    accession: st.accession,
    studyDate: st.studyDate,
    studyTime: st.studyTime,
    ...(st.utcOffset ? { utcOffset: st.utcOffset } : {}),
    report: { ...(st.report.category ? { category: st.report.category } : {}), code: st.report.code, title: st.report.title, conclusion: conclusion(st.report), attachments: [pdfAtt, txtAtt] },
    files,
  });
  log(`study ${st.id}: ${files.length} instances in ${seriesUIDs.size} series, Study Instance UID ${studyUID}`);
}

const manifest = {
  _note: "Generated by scripts/build-data.ts from data/patient.json and data/studies.json. Do not edit.",
  uidNamespace: cfg.uidNamespace,
  patient,
  studies: manifestStudies,
};
write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// SHA256SUMS over every file, sorted by path.
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
const sums = walk(tmp).map((f) => relative(tmp, f)).sort().map((rel) => `${sha256(new Uint8Array(require("node:fs").readFileSync(join(tmp, rel))))}  ${rel}`);
write("SHA256SUMS", sums.join("\n") + "\n");

if (EXPORT) {
  const etmp = `${EXPORT}.tmp`;
  rmSync(etmp, { recursive: true, force: true });
  for (const f of exportFiles) {
    mkdirSync(dirname(join(etmp, f.to)), { recursive: true });
    writeFileSync(join(etmp, f.to), require("node:fs").readFileSync(join(tmp, f.from)));
  }
  const index = {
    _note: "Plain export of the imaging sandbox's sample studies for Josh Example (de-identified real studies, and a CC BY slide rewritten to the same patient). Generated by imaging-sandbox/scripts/build-data.ts; files are byte-identical to what the sandbox serves.",
    patient: { name: `${patient.given.join(" ")} ${patient.family}`, dicomName: patient.dicomName, id: patient.mrn, birthDate: patient.birthDate },
    studies: (manifestStudies as any[]).map((m) => ({
      id: m.id,
      studyInstanceUID: m.studyInstanceUID,
      accession: m.accession,
      studyDate: m.studyDate,
      dir: `dicom/${m.id}`,
      instances: m.files.length,
      ...(m.attribution ? { attribution: m.attribution } : {}),
      reports: { pdf: `reports/${m.id}.pdf`, text: `reports/${m.id}.txt`, conclusion: m.report.conclusion, code: m.report.code },
    })),
  };
  writeFileSync(join(etmp, "index.json"), JSON.stringify(index, null, 2) + "\n");
  rmSync(EXPORT, { recursive: true, force: true });
  renameSync(etmp, EXPORT);
  log(`exported ${exportFiles.length} files to ${relative(process.cwd(), EXPORT) || "."}`);
}

rmSync(OUT, { recursive: true, force: true });
renameSync(tmp, OUT);
const digest = sha256(new TextEncoder().encode(sums.join("\n") + "\n"));
log(`wrote ${sums.length} files to ${relative(process.cwd(), OUT) || "."}; SHA-256 of SHA256SUMS: ${digest}`);
