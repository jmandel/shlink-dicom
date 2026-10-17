// bun test test/pack-cache.test.ts: check fixtures (web/checks/pack-share.ts packAndShare) are
// packed once per input: the same files share the same encrypted bytes again, with no packing;
// other files, or other options, are packed anew.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packAndShare } from "../web/checks/pack-share";
import { writeDicom } from "../web/checks/synthetic";

const cache = mkdtempSync(join(tmpdir(), "pack-cache-test-"));
const realFetch = globalThis.fetch;
let uploads: Map<string, Uint8Array>;
let n = 0;
beforeAll(() => {
  process.env.PACK_CACHE = cache;
  globalThis.fetch = (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST" && path === "/api/shares") return Response.json({ share: { id: `s${++n}` }, controlToken: "t" });
    if (init?.method === "PUT" && path.endsWith(".bin")) uploads.set(path.split("/").pop()!, new Uint8Array(await new Response(init.body).arrayBuffer()));
    return Response.json({});
  }) as any;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.PACK_CACHE;
  rmSync(cache, { recursive: true, force: true });
});

const image = (seed: number) =>
  writeDicom({
    sopUid: `2.25.${seed}`, studyUid: "2.25.100", seriesUid: "2.25.101", modality: "CT", studyDescription: "Cache", seriesDescription: "",
    seriesNumber: 1, instanceNumber: 1, rows: 16, columns: 16, pixels: new Int16Array(256).fill(seed),
  });

async function share(files: { name: string; bytes: Uint8Array }[], o = {}) {
  uploads = new Map();
  const s = await packAndShare("http://server.example", files, o);
  return { s, uploads };
}

test("the same files are shared again from the cache: the same file ids and bytes", async () => {
  const files = [{ name: "a.dcm", bytes: image(1) }];
  const first = await share(files);
  const again = await share(files);
  expect(first.uploads.size).toBe(1);
  expect([...again.uploads.keys()]).toEqual([...first.uploads.keys()]);
  expect([...again.uploads.values()]).toEqual([...first.uploads.values()]);
  expect(again.s.sid).not.toBe(first.s.sid);
});

test("other bytes, or other options, are packed anew", async () => {
  const a = await share([{ name: "a.dcm", bytes: image(1) }]);
  const b = await share([{ name: "a.dcm", bytes: image(2) }]);
  const c = await share([{ name: "a.dcm", bytes: image(1) }], { addOffsetTables: true });
  expect([...b.uploads.keys()]).not.toEqual([...a.uploads.keys()]);
  expect([...c.uploads.keys()]).not.toEqual([...a.uploads.keys()]);
});
