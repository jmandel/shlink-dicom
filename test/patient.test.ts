// bun test test/patient.test.ts: one patient per share (spec/README.md §11.1 step 4), on the Share
// page's packing (web/share/lib) with the packer's rule (shl_dicom_core::patient through wasm).
import { beforeAll, describe, expect, test } from "bun:test";
import { Collection } from "../web/share/lib/ingest";
import { MemBytes } from "../web/share/lib/bytes";
import { buildBundle, planStudyFiles, subsetBundle } from "../web/share/lib/pack";

beforeAll(async () => {
  // The Share page's Rust module, where this tree has it.
  const helper = await import("../web/checks/shl-wasm-bun").catch(() => null);
  await helper?.useShlWasm();
});

const header = (name: string, id: string, birth: string, study: string) => ({
  patientName: name, patientId: id, patientBirthDate: birth, patientSex: "",
  studyInstanceUid: study, seriesInstanceUid: `${study}.1`, sopInstanceUid: `${study}.1.1`, sopClassUid: "1.2.840.10008.5.1.4.1.1.2",
  studyDescription: "CT", studyDate: "20240101", studyTime: "", accessionNumber: "", modality: "CT", seriesNumber: "1", instanceNumber: "1",
  seriesDescription: "", transferSyntax: "1.2.840.10008.1.2.1",
});

async function collection(...people: [string, string, string][]) {
  const c = new Collection();
  people.forEach(([name, id, birth], k) => c.addWithHeader(`${k}.dcm`, new MemBytes(new Uint8Array(200)), header(name, id, birth, `2.25.${k + 1}`) as any));
  await c.finish();
  return c;
}

const patientOf = (b: any) => b.entry.find((e: any) => e.resource.resourceType === "Patient").resource;
const pack = (c: Collection) => buildBundle(c, planStudyFiles(c.list().filter((s) => s.include)));

describe("one patient per share", () => {
  test("two people's studies are refused", async () => {
    const c = await collection(["ALPHA^ANN", "A-1", "19700101"], ["BETA^BOB", "B-2", "19800202"]);
    expect(() => pack(c)).toThrow(/more than one patient/);
  });

  test("leaving one person's study out shares only the other's demographics", async () => {
    const c = await collection(["ALPHA^ANN", "A-1", "19700101"], ["BETA^BOB", "B-2", "19800202"]);
    c.studies.get("2.25.1")!.include = false;
    const owner = pack(c);
    const ids = owner.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id);
    const p = patientOf(subsetBundle(owner, ids).bundle);
    expect(p.name[0].family).toBe("BETA");
    expect(p.identifier).toEqual([{ value: "B-2" }]);
    expect(p.birthDate).toBe("1980-02-02");
  });

  test("the sharer can say they are the same person", async () => {
    const c = await collection(["ALPHA^ANN", "A-1", "19700101"], ["ALPHA-SMITH^ANN", "A-9", "19700101"]);
    expect(() => pack(c)).toThrow(/more than one patient/);
    c.samePatient = true;
    const p = patientOf(pack(c));
    expect(p.identifier).toEqual([{ value: "A-1" }, { value: "A-9" }]);
  });

  test("a given-name variant is the same person", async () => {
    const c = await collection(["EXAMPLE^JOSH", "MRN-1", "19800202"], ["Example^Joshua", "MRN-2", "19800202"]);
    const p = patientOf(pack(c));
    expect(p.name[0].family).toBe("EXAMPLE");
    expect(p.identifier).toEqual([{ value: "MRN-1" }, { value: "MRN-2" }]);
  });
});

describe("reports that name no study", () => {
  test("a link carries one only when the sharer picked it", async () => {
    const c = await collection(["EXAMPLE^JOSH", "MRN-1", "19800202"], ["EXAMPLE^JOSH", "MRN-1", "19800202"]);
    c.looseReports = [{ resource: { resourceType: "DiagnosticReport", status: "final", conclusion: "Old letter" }, include: true, from: "attached" }];
    const owner = pack(c);
    const loose = owner.entry.map((e: any) => e.resource).find((r: any) => r.resourceType === "DiagnosticReport" && !(r.imagingStudy ?? []).length);
    expect(loose).toBeTruthy();
    const first = owner.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource.id;
    const reports = (b: any) => b.entry.filter((e: any) => e.resource.resourceType === "DiagnosticReport").map((e: any) => e.resource.id);
    expect(reports(subsetBundle(owner, [first]).bundle)).toEqual([]);
    expect(reports((subsetBundle as any)(owner, [first], [loose.id]).bundle)).toEqual([loose.id]);
  });
});

describe("instance lengths", () => {
  test("an instance of length 0 is refused", async () => {
    const c = new Collection();
    c.addWithHeader("empty.dcm", new MemBytes(new Uint8Array(0)), header("EXAMPLE^JOSH", "MRN-1", "19800202", "2.25.9") as any);
    await c.finish();
    expect(() => pack(c)).toThrow(/length 0/);
  });
});
