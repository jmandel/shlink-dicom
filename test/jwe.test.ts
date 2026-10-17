// bun test test/jwe.test.ts: the JWE the Share page writes (web/core/jwe.ts encryptJwe) and the
// reader module's checks on Bundle JWEs and SHL links (web/core/reader.ts: crates/shl-dicom-reader,
// the same Rust code as the CLI and the server), against the golden share (fixtures/golden,
// written by reference/test-vector.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { b64urlDecode, b64urlEncode, utf8 } from "../web/core/b64";
import { encryptJwe } from "../web/core/jwe";
import { encodeShlink } from "../web/core/shlink";
import { decryptBundle, parseLink, ReaderError } from "../web/core/reader";

const golden = (f: string) => readFileSync(new URL(`../fixtures/golden/${f}`, import.meta.url), "utf8");
const vector = JSON.parse(golden("vector.json"));
const jwe = golden("bundle.jwe").trim();
/** The reader's code for a failure. */
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof ReaderError ? e.code : String(e)));

describe("Bundle JWEs", () => {
  test("the golden Bundle JWE decrypts to the golden Bundle", async () => {
    const pt = new TextDecoder().decode(await decryptBundle(jwe, vector.shlKey));
    expect(JSON.parse(pt)).toEqual(JSON.parse(golden("bundle.json")));
  });
  test("the golden JWE names its content type: cty application/fhir+json", () => {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(jwe.split(".")[0])));
    expect(header.cty).toBe("application/fhir+json");
  });
  test("encryptJwe writes cty application/fhir+json", async () => {
    const out = await encryptJwe(utf8("{}"), vector.shlKey);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(out.split(".")[0]))).cty).toBe("application/fhir+json");
  });
  test("a round trip through encryptJwe", async () => {
    const data = utf8(JSON.stringify({ resourceType: "Bundle", entry: [] }));
    expect(await decryptBundle(await encryptJwe(data, vector.shlKey), vector.shlKey)).toEqual(data);
  });
  const parts = jwe.split(".");
  const swap = (i: number, v: string) => parts.map((p, k) => (k === i ? v : p)).join(".");
  test("an IV that is not 12 bytes is refused", async () => expect(await code(decryptBundle(swap(2, b64urlEncode(new Uint8Array(16))), vector.shlKey))).toBe("not-jwe"));
  test("a tag that is not 16 bytes is refused", async () => expect(await code(decryptBundle(swap(4, b64urlEncode(new Uint8Array(12))), vector.shlKey))).toBe("not-jwe"));
  test("an encrypted key is refused", async () => expect(await code(decryptBundle(swap(1, "AA"), vector.shlKey))).toBe("not-jwe"));
  test("a zip other than DEF is refused", async () => {
    const hdr = b64urlEncode(utf8(JSON.stringify({ alg: "dir", enc: "A256GCM", zip: "GZ", cty: "application/fhir+json" })));
    expect(await code(decryptBundle(swap(0, hdr), vector.shlKey))).toBe("unsupported");
  });
  test("the wrong key is refused", async () => expect(await code(decryptBundle(jwe, vector.files[0].key))).toBe("decrypt"));
});

describe("SHL links", () => {
  const payload = { url: "https://example.org/shl/x", key: vector.shlKey, flag: "U", v: 1 };
  test("encode and read", async () => expect(await parseLink(encodeShlink(payload))).toMatchObject({ ...payload, direct: true, passcode: false, longLived: false, expired: false }));
  test("a viewer prefix ending in # gets one #", () => expect(encodeShlink(payload, "https://v/view#")).toStartWith("https://v/view#shlink:/"));
  test("a key that is not 32 bytes is refused", async () => expect(await code(parseLink(encodeShlink({ ...payload, key: b64urlEncode(new Uint8Array(31)) })))).toBe("bad-key"));
  test("a padded key is refused: 43 base64url characters only", async () => expect(await code(parseLink(encodeShlink({ ...payload, key: vector.shlKey + "=" })))).toBe("bad-key"));
  test("base64 outside the url alphabet is refused", () => expect(() => b64urlDecode("ab+/")).toThrow());
});
