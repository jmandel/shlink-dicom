// bun test test/compress-transfer.test.ts: handing an image to an encoder worker (web/share/lib/
// compress.ts CompressPool) leaves the image's own bytes in place, also when they are the whole
// buffer of an in-memory staged file and the worker declines to re-encode it.
import { afterAll, expect, test } from "bun:test";

/** A worker that takes the buffer (transferred, as postMessage does) and declines. */
class FakeWorker {
  onmessage: ((ev: { data: any }) => void) | null = null;
  postMessage(m: any, transfer: ArrayBuffer[] = []) {
    const data = structuredClone(m, { transfer });
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, declined: "not smaller" } }));
  }
  terminate() {}
}
// Bun runs every test file in one global scope: the real Worker comes back when this file is done.
const RealWorker = globalThis.Worker;
(globalThis as any).Worker = FakeWorker;
afterAll(() => {
  (globalThis as any).Worker = RealWorker;
});

test("a declined image keeps its bytes", async () => {
  const { CompressPool } = await import("../web/share/lib/compress");
  const { memoryStager } = await import("../web/share/lib/stage");
  const stager = memoryStager();
  const src = await stager.stage("a.dcm", (async function* () {
    yield new Uint8Array(4096).fill(7);
  })());
  const pool = new CompressPool(1);
  const r = await pool.transcode(await src.read(0, src.size), "sv1");
  expect(r).toEqual({ declined: "not smaller" });
  expect(src.size).toBe(4096);
  expect((await src.read(0, src.size)).every((b) => b === 7)).toBe(true);
});
