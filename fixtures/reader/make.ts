// Writes fixtures/reader/cases.json: golden cases for the link reader (crates/shl-dicom-reader),
// which its Rust tests and test/reader.test.ts (the wasm module) both run.
//   bun fixtures/reader/make.ts
// Link and manifest expectations are written out by rule (crates/shl-dicom-reader/README.md).
// Study-index expectations were taken from the viewer's TypeScript parser when this file was
// written, in the reader's shape (series name their file by fileId, report attachments carry
// dataB64); where the reader is stricter they expect an error. That parser is gone (the viewer
// uses the reader): the expectations already in cases.json are kept, and a new index case is
// written from the reader's own answer, to be checked by hand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { b64urlEncode, utf8 } from "../../web/core/b64";
import { parseIndex } from "../../web/core/reader";

const dir = new URL(".", import.meta.url).pathname;
const KEY = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8";
const link = (p: object) => "shlink:/" + b64urlEncode(utf8(JSON.stringify(p)));
const ok = (url: string, extra: object = {}) => ({ url, key: KEY, exp: null, flag: null, label: null, v: null, direct: false, passcode: false, longLived: false, expired: false, ...extra });
const cases: any[] = [];
const L = (name: string, text: string, expect: any, now = 1_800_000_000) => cases.push({ fn: "parse_link", name, text, now, expect });

L("a bare link", link({ url: "https://h.example/m", key: KEY }), { ok: ok("https://h.example/m") });
L("a viewer URL", "https://viewer.example/view#" + link({ url: "https://h.example/b.jwe", key: KEY, flag: "LU", v: 1, label: "Imaging" }),
  { ok: ok("https://h.example/b.jwe", { flag: "LU", v: 1, label: "Imaging", direct: true, longLived: true }) });
L("text around a link", "Here: " + link({ url: "https://h.example/m", key: KEY, flag: "P" }) + " (code by phone)", { ok: ok("https://h.example/m", { flag: "P", passcode: true }) });
L("an expiry passed", link({ url: "https://h.example/m", key: KEY, exp: 1_700_000_000 }), { ok: ok("https://h.example/m", { exp: 1_700_000_000, expired: true }) });
L("an expiry to come", link({ url: "https://h.example/m", key: KEY, exp: 1_900_000_000 }), { ok: ok("https://h.example/m", { exp: 1_900_000_000 }) });
L("a long label is kept", link({ url: "https://h.example/m", key: KEY, label: "x".repeat(120) }), { ok: ok("https://h.example/m", { label: "x".repeat(120) }) });
L("no link", "https://example.com/not-a-link", { error: "not-a-link" });
L("not base64url JSON", "shlink:/!!!", { error: "damaged" });
L("no key", link({ url: "https://h.example/m" }), { error: "missing-url-or-key" });
L("an empty url", link({ url: " ", key: KEY }), { error: "missing-url-or-key" });
L("a key of 42 characters", link({ url: "https://h.example/m", key: KEY.slice(0, 42) }), { error: "bad-key" });
L("a padded key", link({ url: "https://h.example/m", key: KEY + "=" }), { error: "bad-key" });
L("U with P", link({ url: "https://h.example/m", key: KEY, flag: "PU" }), { error: "u-with-p" });
L("version 2", link({ url: "https://h.example/m", key: KEY, v: 2 }), { error: "version" });
L("an unknown flag", link({ url: "https://h.example/m", key: KEY, flag: "LX" }), { error: "bad-flag" });
L("a repeated flag", link({ url: "https://h.example/m", key: KEY, flag: "LL" }), { error: "bad-flag" });
L("a negative expiry", link({ url: "https://h.example/m", key: KEY, exp: -1 }), { error: "bad-exp" });

const M = (name: string, manifest: any, expect: any) => cases.push({ fn: "manifest_location", name, manifest: typeof manifest === "string" ? manifest : JSON.stringify(manifest), expect });
M("the FHIR entry, not the first entry", { files: [{ contentType: "application/smart-health-card", location: "https://elsewhere.example/card" }, { contentType: "application/fhir+json;fhirVersion=4.0.1", location: "https://h.example/cap/x/bundle.jwe" }] }, { ok: "https://h.example/cap/x/bundle.jwe" });
M("a folder location", { files: [{ contentType: "APPLICATION/FHIR+JSON", location: "https://h.example/cap/x/" }] }, { ok: "https://h.example/cap/x/" });
M("http on localhost", { files: [{ contentType: "application/fhir+json", location: "http://localhost:3333/cap/x/bundle.jwe" }] }, { ok: "http://localhost:3333/cap/x/bundle.jwe" });
M("http elsewhere", { files: [{ contentType: "application/fhir+json", location: "http://h.example/cap/x/bundle.jwe" }] }, { error: "bad-location" });
M("a query", { files: [{ contentType: "application/fhir+json", location: "https://h.example/cap/x/bundle.jwe?sig=1" }] }, { error: "bad-location" });
M("a path that names no file", { files: [{ contentType: "application/fhir+json", location: "https://h.example/cap/x" }] }, { error: "bad-location" });
M("an embedded entry only", { files: [{ contentType: "application/fhir+json", embedded: "eyJ" }] }, { error: "no-location" });
M("not JSON", "<html>", { error: "damaged" });

const golden = readFileSync(new URL("../golden/bundle.jwe", import.meta.url), "utf8").trim();
const goldenKey = JSON.parse(readFileSync(new URL("../golden/vector.json", import.meta.url), "utf8")).shlKey;
const D = (name: string, jwe: string, key: string, expect: any) => cases.push({ fn: "decrypt_bundle", name, jwe, key, expect });
const goldenBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(JSON.stringify(JSON.parse(readFileSync(new URL("../golden/bundle.json", import.meta.url), "utf8"))))));
D("the golden Bundle", golden, goldenKey, { okSha256: [...goldenBytes].map((b) => b.toString(16).padStart(2, "0")).join("") });
D("another key", golden, "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8", { error: "decrypt" });
D("four parts", golden.split(".").slice(0, 4).join("."), goldenKey, { error: "not-jwe" });
D("an encrypted key part", golden.replace("..", ".AAAA."), goldenKey, { error: "not-jwe" });

// Study indexes: expectations from the TypeScript parser, in the reader's shape.
function readerShape(ix: any) {
  const { bundle: _b, ...rest } = ix;
  rest.studies = rest.studies.map((st: any) => ({ ...st, series: st.series.map(({ file, ...se }: any) => ({ ...se, fileId: file.fileId })) }));
  rest.reports = rest.reports.map((r: any, k: number) => ({
    ...r,
    attachments: r.attachments.map(({ data, ...a }: any, j: number) => ({ ...a, dataB64: data ? ix.bundle.entry.filter((e: any) => e.resource?.resourceType === "DiagnosticReport")[k].resource.presentedForm[j].data : null })),
  }));
  return rest;
}
const kept = new Map<string, any>(
  existsSync(`${dir}cases.json`) ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")).filter((c: any) => c.fn === "parse_index").map((c: any) => [c.name, c.expect]) : [],
);
const I = async (name: string, bundle: any, expectError = false) => {
  const json = JSON.stringify(bundle);
  if (expectError) return cases.push({ fn: "parse_index", name, bundle: json, expect: { error: "invalid-bundle" } });
  let expect = kept.get(name);
  if (!expect) {
    expect = { ok: readerShape(await parseIndex(utf8(json))) };
    console.error(`new index case "${name}": its expectation is the reader's answer; check it by hand`);
  }
  cases.push({ fn: "parse_index", name, bundle: json, expect });
};
const goldenBundle = JSON.parse(readFileSync(new URL("../golden/bundle.json", import.meta.url), "utf8"));
await I("the golden Bundle", goldenBundle);

const EXT = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/";
const lf = (id: string, key: string) => ({ url: EXT + "linked-file", extension: [{ url: "id", valueString: id }, { url: "key", valueString: key }] });
const inst = (uid: string, length: any, extra: object = {}) => ({ extension: [{ url: EXT + "instance-length", valueDecimal: length }], uid, sopClass: { system: "urn:ietf:rfc:3986", code: "urn:oid:1.2.840.10008.5.1.4.1.1.2" }, ...extra });
const A = "AAECAwQFBgcICQoLDA0ODw", B = "EBESExQVFhcYGRobHB0eHw";
const KA = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8", KB = "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8";
const study = (series: any[], extra: object = {}) => ({ resourceType: "ImagingStudy", id: "ct1", extension: [lf(A, KA)], identifier: [{ system: "urn:dicom:uid", value: "urn:oid:2.25.1" }], series, ...extra });
const b64 = (s: string) => btoa(s);
const rich = {
  resourceType: "Bundle", type: "collection", meta: { lastUpdated: "2026-10-17T00:00:00Z" },
  entry: [
    { fullUrl: "urn:uuid:p", resource: { resourceType: "Patient", name: [{ given: ["Ann", "B"], family: "Alpha" }], birthDate: "1970-01-01", identifier: [{ value: "A-1" }] } },
    { fullUrl: "urn:uuid:s1", resource: study(
      [
        { uid: "2.25.1.1", number: 2, modality: { code: "CT" }, description: "Axial", bodySite: { code: "CHEST" }, instance: [inst("2.25.1.1.1", 100, { number: 1 }), inst("2.25.1.1.2", 70000)] },
        { uid: "2.25.1.2", number: 3, modality: { code: "SR" }, extension: [lf(B, KB)], instance: [inst("2.25.1.2.1", 5)] },
        { uid: "2.25.1.3", modality: { code: "CT" }, bodySite: { display: "Chest" }, instance: [inst("2.25.1.3.1", 7)] },
      ],
      { description: "CT chest", started: "2026-01-02", note: [{ text: "Partial study" }, { text: " " }], identifier: [{ system: "urn:dicom:uid", value: "urn:oid:2.25.1" }, { type: { coding: [{ code: "ACSN" }] }, value: "ACC9" }] },
    ) },
    { fullUrl: "urn:uuid:r1", resource: { resourceType: "DiagnosticReport", id: "r1", status: "final", code: { coding: [{ display: "CT report" }] }, conclusion: "Normal.", effectivePeriod: { start: "2026-01-02" }, imagingStudy: [{ reference: "urn:uuid:s1" }],
      identifier: [{ system: "urn:x", value: "ACC9", type: { coding: [{ code: "ACSN" }] } }, { value: "" }], category: [{ text: "Radiology" }],
      presentedForm: [{ contentType: "text/html", title: "Report", data: b64("<p>Line one</p>  \n  <b>two</b>") }, { contentType: "application/pdf", data: b64("%PDF"), size: 4 }, { contentType: "application/pdf", url: "https://ehr.example/b/1" }] } },
    { fullUrl: "urn:uuid:r2", resource: { resourceType: "DiagnosticReport", status: "preliminary", imagingStudy: [{ reference: "ImagingStudy/ct1", identifier: { value: "urn:oid:2.25.1" } }, { reference: "ImagingStudy/gone" }], presentedForm: [{ contentType: "text/plain", data: b64("  plain text  ") }] } },
    { fullUrl: "urn:uuid:r3", resource: { resourceType: "DiagnosticReport", id: "loose", status: "final", issued: "2026-02-03T00:00:00Z" } },
    { resource: { resourceType: "ImagingStudy", id: "plain", series: [{ uid: "9", instance: [{ uid: "9.1" }] }] } },
  ],
};
await I("a Bundle with reports, notes, accession, body sites and a series-level file", rich);
const err = (mutate: (b: any) => void) => {
  const b = structuredClone(rich);
  mutate(b);
  return b;
};
await I("an instance length of 0", err((b) => (b.entry[1].resource.series[0].instance[0].extension[0].valueDecimal = 0)), true);
await I("an instance length as text", err((b) => (b.entry[1].resource.series[0].instance[0].extension[0].valueDecimal = "100")), true);
await I("an instance length past 2^53 - 1", err((b) => (b.entry[1].resource.series[0].instance[0].extension[0].valueDecimal = 2 ** 53)), true);
await I("a series without instances", err((b) => (b.entry[1].resource.series[2].instance = [])), true);
await I("a series with an empty uid", err((b) => (b.entry[1].resource.series[2].uid = "")), true);
await I("a file given two keys", err((b) => (b.entry[1].resource.series[1].extension = [lf(A, KB)])), true);
await I("a file linked from two studies", err((b) => b.entry.push({ resource: { ...structuredClone(b.entry[1].resource), id: "ct2" } })), true);
await I("a key of 42 characters", err((b) => (b.entry[1].resource.extension = [lf(A, KA.slice(0, 42))])), true);
await I("not a Bundle", { resourceType: "Patient" }, true);

writeFileSync(dir + "cases.json", JSON.stringify(cases, null, 1) + "\n");
console.log(`${cases.length} cases`);
