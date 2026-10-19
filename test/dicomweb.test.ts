import { expect, test } from "bun:test";
import { DicomwebSession, dicomJson, fragmentPayload } from "../web/dicomweb/session";
import { PROTOCOL, receivePort, servePort } from "../web/dicomweb/transport";
import { part10, element, writeDicom } from "../web/checks/synthetic";
import { ciphertextLength, recordCount } from "../web/core/range";
import type { OpenShare } from "../web/core/share";
import { TS } from "../web/core/transfer-syntax";

const ROOT = "https://viewer.example/demos/dicomweb/session/", STUDY = "2.25.2", SERIES = "2.25.3", SOP = "2.25.4", CLASS = "1.2.840.10008.5.1.4.1.1.2";
const instancePath = `studies/${STUDY}/series/${SERIES}/instances/${SOP}`;
const us = (n: number) => new Uint8Array([n & 255, n >> 8]);
const native = () => writeDicom({ studyUid: STUDY, seriesUid: SERIES, sopUid: SOP, modality: "CT", studyDescription: "Test", seriesDescription: "Frames", seriesNumber: 1, instanceNumber: 1, rows: 2, columns: 2, pixels: new Int16Array([-1000, 12, 700, 3000]) });
function fixture(bytes = native(), root = ROOT) {
  let reads = 0;
  const file = { fileId: "file", plaintextLength: bytes.length, ciphertextLength: ciphertextLength(bytes.length), recordCount: recordCount(bytes.length), key: "unused" };
  const se = { id: "file@0", uid: SERIES, number: 1, description: "Frames", modality: "CT", offset: 0, bytes: bytes.length, file, instances: [{ uid: SOP, sopClass: CLASS, offset: 0, length: bytes.length, number: 1 }] };
  const st = { studyInstanceUid: STUDY, description: "Test", modalities: ["CT"], started: "2026-01-01", series: [se] };
  const share = { index: { patient: { name: "TEST^SYNTHETIC", id: "SYN0001" }, studies: [st] }, loader: {
    range: async (_: unknown, p: any) => { reads++; return bytes.slice(p.plaintextStart, p.plaintextEnd); },
    decryptor: { decrypt: async (_: unknown, __: unknown, data: Uint8Array) => data }, report() {},
    async *streamInstance() { yield bytes.subarray(0, 300); yield bytes.subarray(300); },
  } } as unknown as OpenShare;
  const session = new DicomwebSession(share, root);
  return { session, share, bytes, reads: () => reads, request: (path: string, options?: RequestInit) => session.handle(new Request(root + path, options)) };
}
async function parts(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const boundary = /boundary=([^;]+)/.exec(response.headers.get("Content-Type")!)![1];
  const text = Buffer.from(bytes).toString("latin1"), chunks = text.split(`--${boundary}`).slice(1, -1);
  return chunks.map(c => { const at = c.indexOf("\r\n\r\n"); return { headers: c.slice(0, at), bytes: Uint8Array.from(Buffer.from(c.slice(at + 4, -2), "latin1")) }; });
}
test("QIDO inventory, filters, paging and missing resources do not read DICOM pixels", async () => {
  const f = fixture();
  expect((await (await f.request("studies?PatientName=TEST*&limit=1")).json()).length).toBe(1);
  expect((await (await f.request("studies?StudyDate=20250101-20251231")).json()).length).toBe(0);
  expect((await (await f.request("studies?offset=1")).json()).length).toBe(0);
  const series = await (await f.request(`studies/${STUDY}/series`)).json();
  expect(series[0]["0020000E"].Value).toEqual([SERIES]);
  expect(f.reads()).toBe(0);
  for (const path of ["studies/nope", `studies/${STUDY}/wrong/anything/metadata`, `${instancePath}/wrong`]) expect((await f.request(path)).status).toBe(404);
  expect((await f.request("studies?offset=-1")).status).toBe(400);
  expect((await f.request("studies", { method: "POST" })).status).toBe(405);
  f.session.close();
});
test("real Part 10 metadata preserves typed attributes and links Pixel Data; headers are shared", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.request(instancePath + "/metadata"), f.request(`studies/${STUDY}/metadata`)]);
  const [json] = await a.json(); expect(await b.json()).toEqual([json]); expect(f.reads()).toBe(1);
  expect(json["00100010"]).toEqual({ vr: "PN", Value: [{ Alphabetic: "TEST^SYNTHETIC" }] });
  expect(json["00280010"]).toEqual({ vr: "US", Value: [2] });
  expect(json["7FE00010"].BulkDataURI).toBe(ROOT + instancePath + "/bulk/7FE00010");
  expect(json["00020010"]).toBeUndefined(); expect(JSON.stringify(json)).not.toContain("_rawValue");
  f.session.close();
});
test("native WADO frame and original instance preserve bytes, with independent MIME framing", async () => {
  const f = fixture(); const response = await f.request(instancePath + "/frames/1");
  expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toContain(TS.ExplicitLE);
  const [frame] = await parts(response); expect(frame.bytes).toEqual(new Uint8Array(new Int16Array([-1000, 12, 700, 3000]).buffer));
  const raw = await f.request(instancePath, { headers: { Accept: "application/dicom" } }); expect(new Uint8Array(await raw.arrayBuffer())).toEqual(f.bytes);
  const multi = await parts(await f.request(`studies/${STUDY}`)); expect(multi[0].bytes).toEqual(f.bytes);
  expect((await f.request(instancePath + "/frames/0")).status).toBe(404);
  expect((await f.request(instancePath + "/frames/2")).status).toBe(404);
  expect((await f.request(instancePath + "/frames/1", { headers: { Accept: `multipart/related; transfer-syntax=${TS.J2K}` } })).status).toBe(406);
  f.session.close();
});
test("metadata cannot substitute a different instance under the inventory UID", async () => {
  const f = fixture(); f.share.index.studies[0].series[0].instances[0].uid = "2.25.999";
  expect((await f.request(`studies/${STUDY}/metadata`)).status).toBe(422); f.session.close();
});
test("DICOM JSON retains sequences, person names and binary attributes without parser internals", () => {
  expect(dicomJson({ "0040A730": { vr: "SQ", Value: [{ "0040A160": { vr: "UT", Value: ["Finding"], _rawValue: "ignored" } }] }, "00281201": { vr: "OW", Value: [new Uint8Array([1, 2]).buffer] } })).toEqual({ "0040A730": { vr: "SQ", Value: [{ "0040A160": { vr: "UT", Value: ["Finding"] } }] }, "00281201": { vr: "OW", InlineBinary: "AQI=" } });
});
function item(bytes: Uint8Array) { const out = new Uint8Array(bytes.length + 8), dv = new DataView(out.buffer); dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true); dv.setUint32(4, bytes.length, true); out.set(bytes, 8); return out; }
test("encapsulated frame fragments are concatenated without item headers", () => {
  const joined = Uint8Array.from([...item(new Uint8Array([1, 2])), ...item(new Uint8Array([3, 4]))]);
  expect(fragmentPayload(joined)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(() => fragmentPayload(joined.subarray(0, -1))).toThrow("Truncated");
});
function multiframe(photometric: string, bits: number, samples: number, rows: number, columns: number, pixels: number[]) {
  return part10(CLASS, SOP, TS.ExplicitLE, [
    element(8, 0x16, "UI", CLASS), element(8, 0x18, "UI", SOP), element(0x20, 0xd, "UI", STUDY), element(0x20, 0xe, "UI", SERIES),
    element(0x28, 2, "US", us(samples)), element(0x28, 4, "CS", photometric), element(0x28, 8, "IS", "2"), element(0x28, 0x10, "US", us(rows)), element(0x28, 0x11, "US", us(columns)),
    element(0x28, 0x100, "US", us(bits)), element(0x28, 0x101, "US", us(bits)), element(0x28, 0x102, "US", us(bits - 1)), element(0x28, 0x103, "US", us(0)), element(0x7fe0, 0x10, "OB", new Uint8Array(pixels)),
  ]);
}
test("native YBR 422 frame boundaries use two stored samples per pixel", async () => {
  const f = fixture(multiframe("YBR_FULL_422", 8, 3, 1, 2, [1, 2, 3, 4, 5, 6, 7, 8]));
  const frames = await parts(await f.request(instancePath + "/frames/2,1"));
  expect(frames.map(f => [...f.bytes])).toEqual([[5, 6, 7, 8], [1, 2, 3, 4]]); f.session.close();
});
test("one-bit frames crossing a byte are repacked from their first pixel", async () => {
  const f = fixture(multiframe("MONOCHROME2", 1, 1, 1, 5, [0b11010101, 0b00000001]));
  const frames = await parts(await f.request(instancePath + "/frames/1,2"));
  expect(frames.map(f => [...f.bytes])).toEqual([[0b10101], [0b01110]]); f.session.close();
});
test("separate sessions with identical UIDs never share headers or pixel data", async () => {
  const a = fixture(), b = fixture(multiframe("MONOCHROME2", 8, 1, 1, 2, [9, 8, 7, 6]), ROOT.replace("session", "other"));
  const ap = await parts(await a.request(instancePath + "/frames/1")), bp = await parts(await b.request(instancePath + "/frames/1"));
  expect([...bp[0].bytes]).toEqual([9, 8]); expect(ap[0].bytes).not.toEqual(bp[0].bytes);
  expect((await b.session.handle(new Request(ROOT + "studies"))).status).toBe(404); a.session.close(); b.session.close();
});
test("port transport pulls only on demand, delivers owned chunks, and cancels upstream", async () => {
  const channel = new MessageChannel(), received = receivePort(channel.port1);
  let pulls = 0, cancelled = false, signal: AbortSignal | undefined;
  const source = new Uint8Array([4, 5, 6]);
  await servePort(channel.port2, { protocol: PROTOCOL, session: "test", url: ROOT, method: "GET", headers: [] }, async r => {
    signal = r.signal;
    return new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(source); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  });
  const response = await received.response; expect(pulls).toBe(0);
  const reader = response.body!.getReader(); expect((await reader.read()).value).toEqual(source); expect(source.byteLength).toBe(3); expect(pulls).toBe(1);
  await reader.cancel(); await received.done;
  await new Promise(res => setTimeout(res, 5)); expect(cancelled).toBe(true); expect(signal?.aborted).toBe(true); expect(pulls).toBe(1);
});
test("port transport preserves errors before headers and during a response", async () => {
  for (const early of [true, false]) {
    const channel = new MessageChannel(), received = receivePort(channel.port1);
    const rejected = early ? received.response.catch(e => e.message) : undefined;
    await servePort(channel.port2, { protocol: PROTOCOL, session: "test", url: ROOT, method: "GET", headers: [] }, async () => {
      if (early) throw new Error("early failure");
      return new Response(new ReadableStream({ pull() { throw new Error("late failure"); } }, { highWaterMark: 0 }));
    });
    if (early) expect(await rejected).toBe("early failure");
    else await expect((await received.response).arrayBuffer()).rejects.toThrow("late failure");
    await received.done;
  }
});
