// bun test test/patient-issuer.test.ts: the Share page reads Issuer of Patient ID (0010,0021)
// (web/core/dicom-header.ts), so its Bundle's Patient identifier names the issuer as the packer's
// and the seed's do (shl_dicom_core::patient: identifier.assigner.display).
import { beforeAll, expect, test } from "bun:test";
import { readDicomHeader } from "../web/core/dicom-header";
import { MemBytes } from "../web/share/lib/bytes";
import { Collection } from "../web/share/lib/ingest";
import { buildBundle, planStudyFiles } from "../web/share/lib/pack";

beforeAll(async () => {
  const helper = await import("../web/checks/shl-wasm-bun");
  await helper.useShlWasm();
});

/** One Explicit VR Little Endian element (short-length VRs only). */
function el(group: number, element: number, vr: string, value: string): Uint8Array {
  let v = new TextEncoder().encode(value);
  if (v.length % 2) v = Uint8Array.from([...v, vr === "UI" ? 0 : 0x20]);
  const out = new Uint8Array(8 + v.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, element, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  dv.setUint16(6, v.length, true);
  out.set(v, 8);
  return out;
}
const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

function part10(issuer: string | null): Uint8Array {
  const metaBody = cat([el(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.7"), el(0x0002, 0x0003, "UI", "2.25.11"), el(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1")]);
  const len = new Uint8Array(12);
  const dv = new DataView(len.buffer);
  dv.setUint16(0, 0x0002, true);
  dv.setUint16(2, 0x0000, true);
  len.set([0x55, 0x4c], 4);
  dv.setUint16(6, 4, true);
  dv.setUint32(8, metaBody.length, true);
  const pre = new Uint8Array(132);
  pre.set([0x44, 0x49, 0x43, 0x4d], 128);
  return cat([
    pre, len, metaBody,
    el(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.7"), el(0x0008, 0x0018, "UI", "2.25.11"), el(0x0008, 0x0060, "CS", "OT"),
    el(0x0010, 0x0010, "PN", "DOE^JANE"), el(0x0010, 0x0020, "LO", "MRN-7"),
    ...(issuer ? [el(0x0010, 0x0021, "LO", issuer)] : []),
    el(0x0010, 0x0030, "DA", "19700102"),
    el(0x0020, 0x000d, "UI", "2.25.1"), el(0x0020, 0x000e, "UI", "2.25.1.1"),
  ]);
}

test("a file with an Issuer of Patient ID yields it", async () => {
  expect((await readDicomHeader(part10("HOSP-A"))).patientIdIssuer).toBe("HOSP-A");
  expect((await readDicomHeader(part10(null))).patientIdIssuer).toBe("");
});

test("the Share page's Patient names the issuer", async () => {
  const c = new Collection();
  const bytes = part10("HOSP-A");
  c.addWithHeader("a.dcm", new MemBytes(bytes), await readDicomHeader(bytes));
  await c.finish();
  const owner = buildBundle(c, planStudyFiles(c.list()));
  const patient = owner.entry.find((e: any) => e.resource.resourceType === "Patient").resource;
  expect(patient.identifier).toEqual([{ value: "MRN-7", assigner: { display: "HOSP-A" } }]);
});
