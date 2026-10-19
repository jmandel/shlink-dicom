import { beforeAll, expect, test } from "bun:test";
import { element, part10 } from "../web/checks/synthetic";
import { ConcatBytes, MemBytes, SubBytes, type Bytes } from "../web/share/lib/bytes";
import type { Instance, StudyModel } from "../web/share/lib/ingest";
import { studiesLackingOffsetTables } from "../web/share/lib/offset-tables";

beforeAll(async () => { await (await import("../web/checks/shl-wasm-bun")).useShlWasm(); });

const TS = "1.2.840.10008.1.2.4.50";
function header(frames: number, table: "empty" | "basic" | "extended", padding = 0) {
  const pixel = new Uint8Array([0xe0, 0x7f, 0x10, 0, 0x4f, 0x42, 0, 0, 255, 255, 255, 255, 0xfe, 0xff, 0, 0xe0, table === "basic" ? 8 : 0, 0, 0, 0]);
  return part10("1.2.840.10008.5.1.4.1.1.7", "2.25.1", TS, [
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
const instance = (src: Bytes) => ({ src, h: { transferSyntax: TS } } as Instance);
const study = (instances: Instance[]) => ({ series: [{ instances }] } as StudyModel);

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
