// Reports linked to studies by the one rule (crates/shl-dicom-core/src/report_links.rs), as the
// viewer (web/core/reports.ts over the reader's index) and the Share page see them.
// Run: bun test test/report-links.test.ts
import { expect, test } from "bun:test";
import { parseIndex } from "../web/core/reader";
import { linkReports, linksTakenWhenSharing, relinkWithAccessions } from "../web/core/reports";

const LINKED = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file";
const LENGTH = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length";
/** A 16-byte file id or 32-byte key, base64url, unique per `n`. */
const b64 = (n: number, len: number) => Buffer.from(Array.from({ length: len }, (_, i) => (n * 31 + i) & 255)).toString("base64url");

function study(n: number, o: { accession?: string; started?: string; modality?: string } = {}) {
  return {
    fullUrl: `urn:uuid:s${n}`,
    resource: {
      resourceType: "ImagingStudy",
      id: `st${n}`,
      status: "available",
      ...(o.started ? { started: o.started } : {}),
      extension: [{ url: LINKED, extension: [{ url: "id", valueString: b64(n, 16) }, { url: "key", valueString: b64(n + 100, 32) }] }],
      identifier: [
        { system: "urn:dicom:uid", value: `urn:oid:2.25.${n}` },
        ...(o.accession ? [{ type: { coding: [{ code: "ACSN" }] }, value: o.accession }] : []),
      ],
      series: [{ uid: `2.25.${n}.1`, modality: { code: o.modality ?? "CT" }, instance: [{ uid: `2.25.${n}.1.1`, sopClass: { system: "urn:ietf:rfc:3986", code: "urn:oid:1.2.840.10008.5.1.4.1.1.2" }, extension: [{ url: LENGTH, valueDecimal: 100 }] }] }],
    },
  };
}
const report = (id: string, r: object) => ({ resource: { resourceType: "DiagnosticReport", id, status: "final", code: { text: "CT chest" }, ...r } });
const bundle = (...entry: object[]) => ({ resourceType: "Bundle", type: "collection", entry });
const links = (ix: any) => linkReports(ix).map((l) => [l.report.id, l.studyId, l.basis]);

test("a combined report stays with both studies it names", async () => {
  const ix = await parseIndex(bundle(study(1), study(2), report("r", { imagingStudy: [{ reference: "urn:uuid:s1" }, { reference: "ImagingStudy/st2" }] })));
  expect(links(ix)).toEqual([["r", "st1", "reference"], ["r", "st2", "reference"]]);
});

test("an accession number two studies share links the report to neither", async () => {
  const ix = await parseIndex(bundle(study(1, { accession: "A9" }), study(2, { accession: "A9" }), report("r", { identifier: [{ value: "A9" }] })));
  expect(links(ix)).toEqual([["r", null, null]]);
  // Learnt from headers too: still two studies.
  const ix2 = await parseIndex(bundle(study(1), study(2), report("r", { identifier: [{ value: "H7" }] })));
  await relinkWithAccessions(ix2, new Map([["st1", "H7"], ["st2", "H7"]]));
  expect(links(ix2)).toEqual([["r", null, null]]);
  await relinkWithAccessions(ix2, new Map([["st1", "H7"]]));
  expect(links(ix2)).toEqual([["r", "st1", "accession"]]);
});

test("a date-only match is shown as a guess in the viewer and never taken on the Share page", async () => {
  const ix = await parseIndex(bundle(study(1, { started: "2024-05-01", modality: "CT" }), study(2, { started: "2024-05-02", modality: "MR" }), report("r", { effectiveDateTime: "2024-05-01T09:00:00Z" })));
  expect(links(ix)).toEqual([["r", "st1", "date"]]);
  expect(linksTakenWhenSharing(ix)).toEqual([]);
});
