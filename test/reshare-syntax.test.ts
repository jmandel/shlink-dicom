// bun test test/reshare-syntax.test.ts: a re-shared link's images get their transfer syntax from
// the first record of each series (web/share/lib/sources.ts loadLink), so the Share page can
// compress uncompressed images and add offset tables, as it does for files.
import { beforeAll, describe, expect, test } from "bun:test";
import { parseIndex } from "../web/core/reader";
import { RECORD_PLAINTEXT, type RangePlan } from "../web/core/range";
import { Collection } from "../web/share/lib/ingest";
import { loadLink } from "../web/share/lib/sources";
import { studiesLackingOffsetTables } from "../web/share/lib/offset-tables";

beforeAll(async () => {
  const helper = await import("../web/checks/shl-wasm-bun");
  await helper.useShlWasm();
});

const LF = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file";
const IL = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length";
/** An explicit VR little endian element. */
function element(g: number, e: number, vr: string, value: string | Uint8Array): Uint8Array {
  let v = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (v.length % 2) v = Uint8Array.from([...v, 0]);
  const long = ["OB", "OW", "SQ", "UN", "UT"].includes(vr);
  const out = new Uint8Array((long ? 12 : 8) + v.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, g, true);
  dv.setUint16(2, e, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, v.length, true);
  else dv.setUint16(6, v.length, true);
  out.set(v, long ? 12 : 8);
  return out;
}

/** A Part 10 file: preamble, a file meta with the transfer syntax, then `ds`. */
function part10(sopClass: string, sop: string, ts: string, ds: Uint8Array[]): Uint8Array {
  const meta = [element(2, 2, "UI", sopClass), element(2, 3, "UI", sop), element(2, 0x10, "UI", ts)];
  const gl = element(2, 0, "UL", new Uint8Array(new Uint32Array([meta.reduce((a, x) => a + x.length, 0)]).buffer));
  const parts = [new Uint8Array(128), new TextEncoder().encode("DICM"), gl, ...meta, ...ds];
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of parts) (out.set(x, o), (o += x.length));
  return out;
}

const file = (ts: string, sop: string) => part10("1.2.840.10008.5.1.4.1.1.2", sop, ts, [element(0x0008, 0x0018, "UI", sop), element(0x7fe0, 0x0010, "OB", new Uint8Array(100_000))]);

describe("a re-shared link", () => {
  test("reuses its first header without assuming later instances have the same frames or table", async () => {
    const sopClass = "1.2.840.10008.5.1.4.1.1.7.2";
    for (const firstFrames of [1, 20]) {
      const image = (sop: string, frames: number, table: boolean) => part10(sopClass, sop, "1.2.840.10008.1.2.4.50", [
        element(0x0028, 0x0008, "IS", String(frames)),
        new Uint8Array([0xe0, 0x7f, 0x10, 0, 0x4f, 0x42, 0, 0, 255, 255, 255, 255, 0xfe, 0xff, 0, 0xe0, table ? 80 : 0, 0, 0, 0]),
        new Uint8Array(100_000),
      ]);
      const a = image("2.25.11", firstFrames, firstFrames > 1), b = image("2.25.12", 20, false);
      const bytes = new Uint8Array(a.length + b.length);
      bytes.set(a); bytes.set(b, a.length);
      const file = { fileId: "test", plaintextLength: bytes.length, ciphertextLength: bytes.length + 16 * Math.ceil(bytes.length / RECORD_PLAINTEXT) };
      const series = { uid: "2.25.10", offset: 0, bytes: bytes.length, file, instances: [
        { uid: "2.25.11", sopClass, offset: 0, length: a.length },
        { uid: "2.25.12", sopClass, offset: a.length, length: b.length },
      ] };
      let reads = 0;
      const share: any = {
        index: { patient: {}, reports: [], bundle: { entry: [] }, studies: [{ id: "s", studyInstanceUid: "2.25.1", series: [series] }] },
        resolver: { fetchRange: async (plan: RangePlan) => { reads++; return bytes.slice(plan.firstRecord * RECORD_PLAINTEXT, Math.min(bytes.length, (plan.lastRecord + 1) * RECORD_PLAINTEXT)); } },
        decryptor: { decrypt: async (_s: any, plan: RangePlan, ct: Uint8Array) => ct.slice(plan.plaintextStart - plan.firstRecord * RECORD_PLAINTEXT, plan.plaintextEnd - plan.firstRecord * RECORD_PLAINTEXT) },
      };
      const col = new Collection();
      await loadLink(share, col, () => {});
      expect(reads).toBe(1);
      const instances = col.list()[0].series[0].instances;
      expect(instances[0].h.numberOfFrames).toBe(firstFrames);
      expect(instances[1].h.numberOfFrames).toBeUndefined();
      expect(await studiesLackingOffsetTables(col.list())).toEqual(new Set(col.list()));
      expect(reads).toBe(2); // Only the later instance is inspected again.
    }
  });

  test("names each series' transfer syntax", async () => {
    const a = file("1.2.840.10008.1.2.1", "2.25.11"), b = file("1.2.840.10008.1.2.4.70", "2.25.21");
    const bytes = new Uint8Array(a.length + b.length);
    bytes.set(a);
    bytes.set(b, a.length);
    const inst = (uid: string, n: number) => ({ uid, sopClass: { code: "urn:oid:1.2.840.10008.5.1.4.1.1.2" }, extension: [{ url: IL, valueDecimal: n }] });
    const bundle = {
      resourceType: "Bundle", type: "collection",
      entry: [{ resource: { resourceType: "ImagingStudy", id: "s", meta: { profile: ["http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study"] },
        extension: [{ url: LF, extension: [{ url: "id", valueString: "AAECAwQFBgcICQoLDA0ODw" }, { url: "key", valueString: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" }] }],
        identifier: [{ system: "urn:dicom:uid", value: "urn:oid:2.25.1" }],
        series: [{ uid: "2.25.10", modality: { code: "CT" }, instance: [inst("2.25.11", a.length)] }, { uid: "2.25.20", modality: { code: "CT" }, instance: [inst("2.25.21", b.length)] }] } }],
    };
    const share: any = {
      index: await parseIndex(bundle),
      resolver: { fetchRange: async (plan: RangePlan) => bytes.slice(plan.firstRecord * RECORD_PLAINTEXT, Math.min(bytes.length, (plan.lastRecord + 1) * RECORD_PLAINTEXT)) },
      decryptor: { decrypt: async (_s: any, plan: RangePlan, ct: Uint8Array) => ct.slice(plan.plaintextStart - plan.firstRecord * RECORD_PLAINTEXT, plan.plaintextEnd - plan.firstRecord * RECORD_PLAINTEXT) },
    };
    const col = new Collection();
    await loadLink(share, col, () => {});
    const series = col.list()[0].series;
    expect(series.map((se) => [...se.transferSyntaxes])).toEqual([["1.2.840.10008.1.2.1"], ["1.2.840.10008.1.2.4.70"]]);
    expect(series[0].instances[0].h.transferSyntax).toBe("1.2.840.10008.1.2.1");
  });
});
