// bun test test/portal-token.test.ts: the portal's token goes only to its clinical and imaging
// servers and the WADO-RS endpoints the imaging server designates (web/share/lib/smart.ts);
// relative addresses resolve against the clinical base; packed
// reports keep attachment data, never attachment URLs (web/share/lib/pack.ts).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { fhirSearchAll, inlineAttachments, portalUrl, studiesFromBundle, wadoRetrieveParts, wadoUrl, type PortalAuth } from "../web/share/lib/smart";
import { buildBundle } from "../web/share/lib/pack";
import { useShlWasm } from "../web/checks/shl-wasm-bun";

// buildBundle runs the packer's Rust builder.
beforeAll(() => useShlWasm());

const auth: PortalAuth = { token: "T0KEN", clinicalBase: "https://ehr.example/fhir", imagingBase: "https://img.example/dicomweb" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

/** Records every request and whether it carried the token. */
function recorder(answer: (url: string) => Response) {
  const calls: { url: string; token: boolean }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), token: h.get("authorization") === `Bearer ${auth.token}` });
    return answer(String(url));
  }) as any;
  return calls;
}

describe("portalUrl", () => {
  test("relative addresses resolve against the clinical base", () => expect(portalUrl(auth, "Binary/7")).toBe("https://ehr.example/fhir/Binary/7"));
  test("the imaging server is allowed", () => expect(portalUrl(auth, "https://img.example/dicomweb/studies/1")).toBe("https://img.example/dicomweb/studies/1"));
  test("another server is refused", () => expect(() => portalUrl(auth, "https://evil.example/x")).toThrow("another server"));
});

describe("the token stays on the portal", () => {
  test("a next-page link to another server is not followed with the token", async () => {
    const calls = recorder(() => new Response(JSON.stringify({ resourceType: "Bundle", link: [{ relation: "next", url: "https://evil.example/page2" }] })));
    await expect(fhirSearchAll("https://ehr.example/fhir/DiagnosticReport?patient=p", auth)).rejects.toThrow("another server");
    expect(calls.map((c) => c.url)).toEqual(["https://ehr.example/fhir/DiagnosticReport?patient=p"]);
  });
  test("a relative next-page link is followed on the clinical server", async () => {
    let n = 0;
    const calls = recorder(() => new Response(JSON.stringify(n++ ? { resourceType: "Bundle" } : { resourceType: "Bundle", link: [{ relation: "next", url: "DiagnosticReport?page=2" }] })));
    await fhirSearchAll("https://ehr.example/fhir/DiagnosticReport?patient=p", auth);
    expect(calls).toEqual([
      { url: "https://ehr.example/fhir/DiagnosticReport?patient=p", token: true },
      { url: "https://ehr.example/fhir/DiagnosticReport?page=2", token: true },
    ]);
  });
  test("attachments elsewhere are not fetched; relative ones are, and lose their url", async () => {
    const calls = recorder(() => new Response(new Uint8Array([1, 2, 3])));
    const r = await inlineAttachments({ resourceType: "DiagnosticReport", presentedForm: [{ url: "https://evil.example/a.pdf" }, { url: "Binary/9", contentType: "application/pdf" }] }, auth);
    expect(calls).toEqual([{ url: "https://ehr.example/fhir/Binary/9", token: true }]);
    expect(r.presentedForm).toEqual([{ contentType: "application/pdf", data: "AQID", size: 3 }]);
  });
  const studyWith = (address: string, connection = "dicom-wado-rs") => ({
    entry: [
      { fullUrl: "https://img.example/fhir/ImagingStudy/s", resource: { resourceType: "ImagingStudy", identifier: [{ system: "urn:dicom:uid", value: "urn:oid:1.2.3" }], endpoint: [{ reference: "Endpoint/e" }] } },
      { fullUrl: "https://img.example/fhir/Endpoint/e", resource: { resourceType: "Endpoint", id: "e", status: "active", connectionType: { code: connection }, address } },
    ],
  });
  test("a WADO-RS Endpoint the imaging server designates is used, on another server too", () => {
    const a: PortalAuth = { ...auth, wadoBases: new Set() };
    expect(studiesFromBundle(studyWith("https://pacs.example/wado/ctx/"), a).map((s) => s.wadoBase)).toEqual(["https://pacs.example/wado/ctx"]);
    expect([...a.wadoBases!]).toEqual(["https://pacs.example/wado/ctx"]);
    expect(wadoUrl(a, "https://pacs.example/wado/ctx/studies/1.2.3")).toBe("https://pacs.example/wado/ctx/studies/1.2.3");
  });
  test("an Endpoint over plain http elsewhere, or not WADO-RS, gives no base", () => {
    const a: PortalAuth = { ...auth, wadoBases: new Set() };
    expect(studiesFromBundle(studyWith("http://pacs.example/wado"), a)).toEqual([]);
    expect(studiesFromBundle(studyWith("https://viewer.example/launch", "ihe-iid"), a)).toEqual([]);
    expect(a.wadoBases!.size).toBe(0);
  });
  test("the token goes only under a designated base", async () => {
    const a: PortalAuth = { ...auth, wadoBases: new Set(["https://pacs.example/wado/ctx"]) };
    expect(() => wadoUrl(a, "https://pacs.example/wado/other/studies/1")).toThrow("another server");
    expect(() => wadoUrl(a, "https://pacs.example/wado/ctxevil/studies/1")).toThrow("another server");
    expect(() => wadoUrl(a, "https://evil.example/wado/ctx/studies/1")).toThrow("another server");
    const calls = recorder(() => new Response("", { status: 404 }));
    await expect(wadoRetrieveParts("https://evil.example/studies/1", a).next()).rejects.toThrow("another server");
    expect(calls).toEqual([]);
  });
});

describe("packed reports", () => {
  test("keep attachment data, not attachment URLs", () => {
    const col: any = { patient: { name: null, birthDate: null, identifier: [] }, studies: new Map(), looseReports: [
      { include: true, resource: { resourceType: "DiagnosticReport", status: "final", presentedForm: [{ url: "https://ehr.example/fhir/Binary/9", data: "AQID", contentType: "application/pdf" }, { url: "https://ehr.example/fhir/Binary/10" }] } },
    ] };
    const b = buildBundle(col, []);
    const dr = b.entry.find((e: any) => e.resource.resourceType === "DiagnosticReport").resource;
    expect(dr.presentedForm).toEqual([{ data: "AQID", contentType: "application/pdf" }]);
  });
});
