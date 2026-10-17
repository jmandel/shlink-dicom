// bun test test/jwe.test.ts: the browser's JWE and SHL link code (web/core/jwe.ts, shlink.ts)
// against the golden share (fixtures/golden, written by reference/test-vector.ts) and the checks
// the Rust reader makes (crates/shl-dicom-core/src/jwe.rs, shl.rs).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { b64urlDecode, b64urlEncode, utf8 } from "../web/core/b64";
import { decryptJwe, encryptJwe, JweError } from "../web/core/jwe";
import { encodeShlink, InvalidLinkError, parseShlink } from "../web/core/shlink";

const golden = (f: string) => readFileSync(new URL(`../fixtures/golden/${f}`, import.meta.url), "utf8");
const vector = JSON.parse(golden("vector.json"));
const jwe = golden("bundle.jwe").trim();

describe("decryptJwe", () => {
  test("the golden Bundle JWE decrypts to the golden Bundle", async () => {
    const pt = new TextDecoder().decode(await decryptJwe(jwe, vector.shlKey));
    expect(JSON.parse(pt)).toEqual(JSON.parse(golden("bundle.json")));
  });
  test("a round trip through encryptJwe", async () => {
    const data = utf8(JSON.stringify({ resourceType: "Bundle", entry: [] }));
    expect(await decryptJwe(await encryptJwe(data, vector.shlKey), vector.shlKey)).toEqual(data);
  });
  const parts = jwe.split(".");
  const swap = (i: number, v: string) => parts.map((p, k) => (k === i ? v : p)).join(".");
  test("an IV that is not 12 bytes is refused", () => expect(decryptJwe(swap(2, b64urlEncode(new Uint8Array(16))), vector.shlKey)).rejects.toThrow("IV"));
  test("a tag that is not 16 bytes is refused", () => expect(decryptJwe(swap(4, b64urlEncode(new Uint8Array(12))), vector.shlKey)).rejects.toThrow("tag"));
  test("an encrypted key is refused", () => expect(decryptJwe(swap(1, "AA"), vector.shlKey)).rejects.toThrow(JweError));
  test("a zip other than DEF is refused", () => {
    const hdr = b64urlEncode(utf8(JSON.stringify({ alg: "dir", enc: "A256GCM", zip: "GZ" })));
    return expect(decryptJwe(swap(0, hdr), vector.shlKey)).rejects.toThrow("zip");
  });
  test("the wrong key is refused", () => expect(decryptJwe(jwe, vector.files[0].key)).rejects.toThrow(JweError));
});

describe("SHL links", () => {
  const payload = { url: "https://example.org/shl/x", key: vector.shlKey, flag: "U", v: 1 };
  test("encode and parse", () => expect(parseShlink(encodeShlink(payload))).toEqual(payload));
  test("a viewer prefix ending in # gets one #", () => expect(encodeShlink(payload, "https://v/view#")).toStartWith("https://v/view#shlink:/"));
  test("a key that is not 32 bytes is refused", () =>
    expect(() => parseShlink(encodeShlink({ ...payload, key: b64urlEncode(new Uint8Array(31)) }))).toThrow(InvalidLinkError));
  test("a padded 32-byte key is accepted", () => expect(parseShlink(encodeShlink({ ...payload, key: vector.shlKey + "=" })).key).toBe(vector.shlKey + "="));
  test("base64 outside the url alphabet is refused", () => expect(() => b64urlDecode("ab+/")).toThrow());
});
