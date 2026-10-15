// Opens a link the way a receiver does and compares every instance with the original files.
//   bun web/checks/share-verify.ts '<shlink or viewer URL>' [archive.tgz …] [--passcode=1234]
// Prints JSON: studies, series, instances, reports, and (with archives) how many instances are
// byte-identical to the archive member with the same SOP Instance UID.
import { readFileSync } from "node:fs";
import { openShare } from "../core/index";
import { readDicomHeader } from "../core/dicom-header";
import { planRuns } from "../core/range";
import { expand } from "../share/lib/ingest";

const args = process.argv.slice(2);
const link = args[0];
const pass = args.find((a) => a.startsWith("--passcode="))?.slice(11);
const archives = args.slice(1).filter((a) => !a.startsWith("--"));

const hex = async (b: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", b as BufferSource)).toString("hex");

const originals = new Map<string, string>();
for (const a of archives) {
  for await (const e of expand(a, new Uint8Array(readFileSync(a)))) {
    try {
      const h = readDicomHeader(e.bytes);
      if (h.sopInstanceUid) originals.set(h.sopInstanceUid, await hex(e.bytes));
    } catch {}
  }
}

const share = await openShare(link, { passcode: pass, recipient: "share-verify" });
let instances = 0, matched = 0, mismatched = 0, missing = 0;
for (const st of share.index.studies) {
  for (const se of st.series) {
    for (const plan of planRuns(se)) {
      const parts = await share.loader.run(se, plan);
      for (let k = 0; k < parts.length; k++) {
        instances++;
        const inst = se.instances[plan.firstInstance + k];
        if (!archives.length) continue;
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
    reports: share.index.reports.map((r) => ({ title: r.title, studyIds: r.studyIds, hasText: !!r.text, forms: (share.index.bundle.entry.find((e: any) => e.resource.id === r.id)?.resource.presentedForm ?? []).map((f: any) => f.contentType) })),
    instances,
    originals: originals.size,
    matched,
    mismatched,
    missing,
  }),
);
