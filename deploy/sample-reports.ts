// Writes the sandbox's DiagnosticReports for the sample, with their attachments inline, as
// <out>/reports.json: [{ studyInstanceUid, report }]. The server seed adds them to the sample's Bundle.
//   bun deploy/sample-reports.ts <dataset dir> <out dir>
import { loadConfig } from "../imaging-sandbox/src/config";
import { loadStore } from "../imaging-sandbox/src/data";
import { diagnosticReport } from "../imaging-sandbox/src/fhir";

const [dataset = "imaging-sandbox/build/dataset", out = "data/samples"] = process.argv.slice(2);
const store = await loadStore(dataset, "/nonexistent");
const cfg = loadConfig({});
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const reports = [...store.studies.values()].map((st) => {
  const r: any = diagnosticReport(cfg, st);
  const byTitle = new Map(st.report.attachments.map((a) => [a.title, a]));
  r.presentedForm = (r.presentedForm ?? []).map(({ url: _url, ...f }: any) => ({ ...f, data: b64(byTitle.get(f.title)!.bytes) }));
  delete r.meta;
  return { studyInstanceUid: st.uid, report: r };
});
await Bun.write(`${out}/reports.json`, JSON.stringify(reports, null, 1) + "\n");
console.log(`${reports.length} reports → ${out}/reports.json`);
