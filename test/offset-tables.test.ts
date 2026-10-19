import { beforeAll, expect, test } from "bun:test";
import { element, part10 } from "../web/checks/synthetic";
import { ConcatBytes, MemBytes, SubBytes, type Bytes } from "../web/share/lib/bytes";
import type { DicomHeader } from "../web/core/dicom-header";
import { Collection } from "../web/share/lib/ingest";
import type { Instance, StudyModel } from "../web/share/lib/ingest";
import { rememberOffsetTableHeader, studiesLackingOffsetTables } from "../web/share/lib/offset-tables";

beforeAll(async () => { await (await import("../web/checks/shl-wasm-bun")).useShlWasm(); });

const TS = "1.2.840.10008.1.2.4.50";
function header(frames: number, table: "empty" | "basic" | "extended", padding = 0) {
  const pixel = new Uint8Array([0xe0, 0x7f, 0x10, 0, 0x4f, 0x42, 0, 0, 255, 255, 255, 255, 0xfe, 0xff, 0, 0xe0, table === "basic" ? 8 : 0, 0, 0, 0]);
  return part10("1.2.840.10008.5.1.4.1.1.7.2", "2.25.1", TS, [
    element(0x0020, 0x000d, "UI", "2.25.2"),
    element(0x0020, 0x000e, "UI", "2.25.3"),
    element(0x0028, 0x0008, "IS", String(frames)),
    ...(padding ? [element(0x0043, 0x0010, "OB", new Uint8Array(padding))] : []),
    ...(table === "extended" ? [element(0x7fe0, 0x0001, "OV", new Uint8Array(16))] : []),
    pixel,
  ]);
}
function large(head: Uint8Array) {
  const reads: number[] = [];
  const src: Bytes = { size: 100 << 20, async read(a, b) {
    reads.push(b - a);
    const out = new Uint8Array(b - a);
    if (a < head.length) out.set(head.subarray(a, Math.min(b, head.length)));
    return out;
  } };
  return { src, reads };
}
const instance = (src: Bytes, h: Partial<DicomHeader> = {}) => ({ src, h: { transferSyntax: TS, ...h } } as Instance);
const study = (instances: Instance[]) => ({ series: [{ instances }] } as StudyModel);

test("known single-frame classes need no byte reads or checking progress", async () => {
  const src: Bytes = { size: 100 << 20, async read() { throw new Error("unnecessary header read"); } };
  const instances = ["1", "2", "4", "7"].map((uid) => instance(src, { sopClassUid: `1.2.840.10008.5.1.4.1.1.${uid}` }));
  const progress: number[] = [];
  expect((await studiesLackingOffsetTables([study(instances)], (done) => progress.push(done))).size).toBe(0);
  expect(progress).toEqual([]);
});

test("enhanced CT/MR, multi-frame SC, WSI and unknown classes remain candidates", async () => {
  for (const sopClassUid of ["2.1", "4.1", "7.2", "77.1.6"].map((uid) => `1.2.840.10008.5.1.4.1.1.${uid}`).concat("1.2.3.4.5", "")) {
    const f = large(header(20, "empty"));
    const st = study([instance(f.src, { sopClassUid })]);
    expect(await studiesLackingOffsetTables([st])).toEqual(new Set([st]));
    expect(f.reads).toEqual([4 << 10]);
  }
});

test("an observed frame count is used without guessing from a modality or another instance", async () => {
  const f = large(header(20, "empty"));
  const st = study([instance(f.src, { sopClassUid: "1.2.840.10008.5.1.4.1.1.2.1", numberOfFrames: 1 })]);
  expect((await studiesLackingOffsetTables([st])).size).toBe(0);
  expect(f.reads).toEqual([]);
  const nonconformant = study([instance(f.src, { sopClassUid: "1.2.840.10008.5.1.4.1.1.7", numberOfFrames: 20 })]);
  expect(await studiesLackingOffsetTables([nonconformant])).toEqual(new Set([nonconformant]));
});

test("ingestion reuses complete header probes for both existing and missing tables", async () => {
  for (const table of ["basic", "extended", "empty"] as const) {
    const f = large(header(20, table));
    const col = new Collection();
    await col.add("image.dcm", f.src);
    expect(col.instanceCount).toBe(1);
    expect(col.list()[0].series[0].instances[0].h.numberOfFrames).toBe(20);
    const readsAfterIngestion = f.reads.slice();
    const lacking = await studiesLackingOffsetTables(col.list());
    expect(lacking.size).toBe(table === "empty" ? 1 : 0);
    expect(f.reads).toEqual(readsAfterIngestion);
  }
});

test("an incomplete reused header does not suppress the later probe", async () => {
  const f = large(header(20, "empty", 100 << 10));
  const inst = instance(f.src);
  rememberOffsetTableHeader(inst, header(20, "empty", 100 << 10).slice(0, 4 << 10));
  const st = study([inst]);
  expect(await studiesLackingOffsetTables([st])).toEqual(new Set([st]));
  expect(f.reads).toEqual([4 << 10, 64 << 10, 256 << 10]);
});

test("large single-frame files and existing basic/extended tables need only a small header read", async () => {
  for (const [frames, table] of [[1, "empty"], [20, "basic"], [20, "extended"]] as const) {
    const f = large(header(frames, table));
    const st = study([instance(f.src)]);
    expect((await studiesLackingOffsetTables([st])).size).toBe(0);
    expect(f.reads).toEqual([4 << 10]);
    await studiesLackingOffsetTables([st]);
    expect(f.reads).toHaveLength(1);
  }
});

test("a missing table is detected after growing an incomplete header, without reading pixels", async () => {
  const f = large(header(20, "empty", 100 << 10));
  const st = study([instance(f.src)]);
  expect(await studiesLackingOffsetTables([st])).toEqual(new Set([st]));
  expect(f.reads).toEqual([4 << 10, 64 << 10, 256 << 10]);
});

test("large existing tables also stop as soon as the header is complete", async () => {
  const f = large(header(20, "basic", 100 << 10));
  expect((await studiesLackingOffsetTables([study([instance(f.src)])])).size).toBe(0);
  expect(f.reads).toEqual([4 << 10, 64 << 10, 256 << 10]);
});

test("header reads run concurrently with a bound, and report measured progress", async () => {
  let active = 0, peak = 0;
  const head = header(1, "empty");
  const instances = Array.from({ length: 18 }, () => instance({ size: head.length, async read() {
    peak = Math.max(peak, ++active);
    await Bun.sleep(2);
    active--;
    return head;
  } }));
  const progress: [number, number][] = [];
  await studiesLackingOffsetTables([study(instances)], (done, total) => progress.push([done, total]));
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(6);
  expect(progress).toEqual(Array.from({ length: 19 }, (_, i) => [i, 18]));
});

test("cancel propagates through byte windows and stops reads and progress", async () => {
  const ctl = new AbortController();
  let reads = 0;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const src: Bytes = { size: 100 << 20, async read(_a, _b, signal) {
    reads++;
    expect(signal).toBe(ctl.signal);
    started();
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  } };
  const progress: number[] = [];
  const wrapped = new ConcatBytes([new MemBytes(new Uint8Array()), new SubBytes(src, 0, src.size)]);
  const pending = studiesLackingOffsetTables([study([instance(wrapped)])], (done) => progress.push(done), ctl.signal);
  const outcome = pending.catch((error) => error);
  await began;
  ctl.abort(new Error("cancelled"));
  expect((await outcome).message).toBe("cancelled");
  expect(reads).toBe(1);
  expect(progress).toEqual([0]);
});
