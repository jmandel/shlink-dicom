// Opens a link the way a receiver does and compares every instance with the original files.
//   bun web/checks/share-verify.ts '<shlink or viewer URL>' [file, archive or folder …] [--index-only] [--passcode=1234]
// Prints JSON: studies, series, instances, reports, and (with archives) how many instances are
// byte-identical to the archive member with the same SOP Instance UID.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openShare } from "../core/index";
import { linkReports } from "../core/reports";
import { readDicomHeader } from "../core/dicom-header";
import { planRuns } from "../core/range";
import { expand } from "../share/lib/ingest";
import { BlobBytes } from "../share/lib/bytes";
import { memoryStager } from "../share/lib/stage";

const args = process.argv.slice(2);
const link = args[0];
const pass = args.find((a) => a.startsWith("--passcode="))?.slice(11);
const indexOnly = args.includes("--index-only");
const archives = args.slice(1).filter((a) => !a.startsWith("--"));
// (--ref-link is read below.)

const hex = async (b: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", b as BufferSource)).toString("hex");

const originals = new Map<string, string>();
const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f))) : [p]);
for (const a of archives.flatMap(walk)) {
  for await (const e of expand(a, new BlobBytes(Bun.file(a)), memoryStager())) {
    try {
      const bytes = await e.src.read(0, e.src.size);
      const h = readDicomHeader(bytes);
      if (h.sopInstanceUid) originals.set(h.sopInstanceUid, await hex(bytes));
    } catch {}
  }
}

// --ref-link=<shlink>: compare with the instances of another link (a re-share against its source).
const refLink = args.find((a) => a.startsWith("--ref-link="))?.slice(11);
const refPass = args.find((a) => a.startsWith("--ref-passcode="))?.slice(15);
if (refLink) {
  const ref = await openShare(refLink, { passcode: refPass, recipient: "share-verify" });
  const want = new Set<string>();
  {
    const tmp = await openShare(link, { passcode: pass, recipient: "share-verify" });
    for (const st of tmp.index.studies) for (const se of st.series) for (const i of se.instances) want.add(i.uid);
  }
  for (const st of ref.index.studies) {
    for (const se of st.series) {
      if (!se.instances.some((i) => want.has(i.uid))) continue;
      for (const plan of planRuns(se)) {
        const parts = await ref.loader.run(se, plan);
        for (let k = 0; k < parts.length; k++) originals.set(se.instances[plan.firstInstance + k].uid, await hex(parts[k]));
      }
    }
  }
}

const share = await openShare(link, { passcode: pass, recipient: "share-verify" });
let instances = 0, matched = 0, mismatched = 0, missing = 0;
for (const st of indexOnly ? [] : share.index.studies) {
  for (const se of st.series) {
    for (const plan of planRuns(se)) {
      const parts = await share.loader.run(se, plan);
      for (let k = 0; k < parts.length; k++) {
        instances++;
        const inst = se.instances[plan.firstInstance + k];
        if (!archives.length && !refLink) continue;
        const want = originals.get(inst.uid);
        if (!want) missing++;
        else if (want === (await hex(parts[k]))) matched++;
        else mismatched++;
      }
    }
  }
}
console.log(
  JSON.stringify({
    label: share.resolver.label,
    patient: share.index.patient.name,
    studies: share.index.studies.map((s) => ({ id: s.id, description: s.description, started: s.started, series: s.series.length, instances: s.numberOfInstances })),
    reports: linkReports(share.index).map(({ report: r, studyId, basis }) => {
      const res = share.index.bundle.entry.find((e: any) => e.resource.id === r.id)?.resource ?? {};
      const ref = String(res.imagingStudy?.[0]?.reference ?? "");
      const target = share.index.bundle.entry.find((e: any) => e.fullUrl === ref && e.resource?.resourceType === "ImagingStudy");
      return {
        title: r.title,
        studyIds: studyId ? [studyId] : [],
        // How the viewer links it ("reference", "accession", "date" or null), and whether imagingStudy
        // points at that study's fullUrl in this Bundle.
        basis,
        byFullUrl: !!target && target.resource.id === studyId,
        hasText: !!r.text,
        forms: (res.presentedForm ?? []).map((f: any) => f.contentType),
      };
    }),
    instances,
    originals: originals.size,
    matched,
    mismatched,
    missing,
  }),
);
