// bun test test/reader.test.ts: the link reader's wasm module (crates/shl-dicom-reader) on the
// golden cases its Rust tests also run (fixtures/reader/cases.json), and in a Worker.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decrypt_bundle, initSync, manifest_location, open_bundle, parse_index, parse_link } from "../crates/shl-dicom-reader/pkg/shl_dicom_reader.js";

initSync({ module: readFileSync(new URL("../crates/shl-dicom-reader/pkg/shl_dicom_reader_bg.wasm", import.meta.url)) });
const cases: any[] = JSON.parse(readFileSync(new URL("../fixtures/reader/cases.json", import.meta.url), "utf8"));
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The function's result, or { error: code } from the JSON in a thrown error's message. */
async function run(c: any): Promise<any> {
  try {
    switch (c.fn) {
      case "parse_link": return { ok: JSON.parse(parse_link(c.text, c.now)) };
      case "manifest_location": return { ok: manifest_location(c.manifest) };
      case "decrypt_bundle": return { okSha256: await hex(decrypt_bundle(c.jwe, c.key)) };
      case "parse_index": return { ok: JSON.parse(parse_index(new TextEncoder().encode(c.bundle))) };
    }
  } catch (e) {
    return { error: JSON.parse((e as Error).message).code };
  }
  throw new Error(`unknown fn ${c.fn}`);
}

describe("golden cases", () => {
  for (const c of cases) test(`${c.fn}: ${c.name}`, async () => expect(await run(c)).toEqual(c.expect));
});

describe("open_bundle", () => {
  const jwe = readFileSync(new URL("../fixtures/golden/bundle.jwe", import.meta.url), "utf8").trim();
  const key = JSON.parse(readFileSync(new URL("../fixtures/golden/vector.json", import.meta.url), "utf8")).shlKey;
  test("decrypts and indexes in one call", () => {
    const o = open_bundle(jwe, key);
    expect(JSON.parse(o.index)).toEqual(JSON.parse(parse_index(o.bundle)));
    expect(JSON.parse(new TextDecoder().decode(o.bundle)).resourceType).toBe("Bundle");
  });
  test("runs in a Worker (no DOM)", async () => {
    const w = new Worker(new URL("./reader-worker.ts", import.meta.url).href);
    const wasm = readFileSync(new URL("../crates/shl-dicom-reader/pkg/shl_dicom_reader_bg.wasm", import.meta.url));
    const got: any = await new Promise((resolve) => {
      w.onmessage = (e) => resolve(e.data);
      w.postMessage({ wasm, jwe, key });
    });
    w.terminate();
    expect(got.error).toBeUndefined();
    expect(JSON.parse(got.index).studies.length).toBe(1);
    expect(got.bundle.byteLength).toBeGreaterThan(0);
  });
});
