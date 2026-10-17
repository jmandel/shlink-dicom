// bun test test/apply-choices.test.ts: what the person chose (the portal's Patient, the studies'
// details, the reports left in) survives a reload while files are compressed on the way: the owner
// Bundle stored before uploading (buildBundle, the Rust builder) put back on the collection read
// again (web/share/lib/pack.ts applyChoices).
import { beforeAll, describe, expect, test } from "bun:test";
import { MemBytes } from "../web/share/lib/bytes";
import { Collection } from "../web/share/lib/ingest";
import { applyChoices, buildBundle, planStudyFiles } from "../web/share/lib/pack";

beforeAll(async () => {
  const helper = await import("../web/checks/shl-wasm-bun");
  await helper.useShlWasm();
});

const header = (study: string, k: number) => ({
  patientName: "DOE^JANE", patientId: "MRN-DICOM", patientBirthDate: "19700102", patientSex: "",
  studyInstanceUid: study, seriesInstanceUid: `${study}.1`, sopInstanceUid: `${study}.1.${k}`, sopClassUid: "1.2.840.10008.5.1.4.1.1.2",
  studyDescription: "DICOM DESC", studyDate: "20240101", studyTime: "", accessionNumber: "", modality: "CT", seriesNumber: "1", instanceNumber: String(k),
  seriesDescription: "", transferSyntax: "1.2.840.10008.1.2.1",
});

/** A collection as the files give it: DICOM details, no reports. */
async function fromFiles() {
  const c = new Collection();
  for (const [study, n] of [["2.25.1", 2], ["2.25.2", 1]] as const) {
    for (let k = 1; k <= n; k++) c.addWithHeader(`${study}-${k}.dcm`, new MemBytes(new Uint8Array(200 + k)), header(study, k) as any);
  }
  await c.finish();
  return c;
}
const report = (title: string) => ({ resourceType: "DiagnosticReport", status: "final", code: { text: title }, presentedForm: [{ contentType: "application/pdf", data: "JVBERg==" }] });

/** The same collection after the person read it from the portal and chose. */
async function chosen() {
  const c = await fromFiles();
  c.patientSource = "fhir";
  c.patient = { name: "Jane Q Doe", birthDate: "1970-01-02", identifier: [{ system: "urn:mrn", value: "77" }], humanName: { text: "Jane Q Doe", family: "Doe", given: ["Jane", "Q"] } };
  const [a, b] = c.list();
  Object.assign(a, { description: "CT Chest from the portal", started: "2024-05-06", accession: "ACC1" });
  a.reports = [{ resource: report("Kept"), include: true, from: "portal" }, { resource: report("Left out"), include: false, from: "portal" }];
  b.description = "Second study";
  c.looseReports = [{ resource: report("Loose kept"), include: true, from: "portal" }, { resource: report("Loose left out"), include: false, from: "portal" }];
  return c;
}

/** The Bundle without what differs on every build (fullUrls). */
const strip = (b: any) =>
  b.entry.map((e: any) => ({ ...e.resource, ...(e.resource.imagingStudy ? { imagingStudy: e.resource.imagingStudy.map((x: any) => x.identifier) } : {}) }));

describe("choices after a reload while compressing", () => {
  test("the owner Bundle after a reload says what the person chose", async () => {
    const c = await chosen();
    const packed = planStudyFiles(c.list());
    const stored = buildBundle(c, packed, "t");
    const again = await fromFiles();
    applyChoices(again, stored, "fhir");
    const after = buildBundle(again, packed.map((p, i) => ({ ...p, study: again.list()[i] })), "t");
    expect(strip(after)).toEqual(strip(stored));
    expect(after.entry.filter((e: any) => e.resource.resourceType === "DiagnosticReport").map((e: any) => e.resource.code.text)).toEqual(["Kept", "Loose kept"]);
    expect(after.entry[0].resource.name[0].text).toBe("Jane Q Doe");
  });
  test("files' own patient stays the files' (DICOM source)", async () => {
    const c = await fromFiles();
    const packed = planStudyFiles(c.list());
    const stored = buildBundle(c, packed, "t");
    const again = await fromFiles();
    applyChoices(again, stored, "dicom");
    expect(again.patientSource).toBe("dicom");
    expect(strip(buildBundle(again, packed.map((p, i) => ({ ...p, study: again.list()[i] })), "t"))).toEqual(strip(stored));
  });
});
