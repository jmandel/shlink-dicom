// bun test test/reader-hardening.test.ts: the browser readers bound what a damaged or hostile file,
// Bundle or host can make them do (crypto/client review: R1–R4, K3, K6, K8, cty).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { frameTableFromHeader, parseSlideHeader, MAX_FRAMES, type SlideHeader } from "../web/core/wsi";
import { SeriesReader } from "../web/core/wsi-source";
import { InvalidBundleError, MAX_INSTANCE_BYTES, parseStudyIndex } from "../web/core/bundle";
import { InstanceLoader } from "../web/core/loader";
import { ciphertextLength, recordCount, RECORD_PLAINTEXT } from "../web/core/range";
import { decryptJwe, encryptJwe, JweError, MAX_JWE_CHARS, randomKeyB64 } from "../web/core/jwe";
import { b64urlEncode, utf8 } from "../web/core/b64";
import { seriesKey } from "../web/core/decrypt";
import { LinkError, LinkResolver } from "../web/core/resolver";
import { encodeShlink } from "../web/core/shlink";
import { element, part10 } from "../web/checks/synthetic";

const header = (o: Partial<SlideHeader>): SlideHeader =>
  ({ complete: true, encapsulated: true, numberOfFrames: 3, firstFragmentOffset: 1000, extendedOffsets: null, basicOffsets: null, ...o }) as SlideHeader;

describe("R1: offset tables", () => {
  test("a strictly increasing table inside the instance is used", () => expect(frameTableFromHeader(header({ basicOffsets: [0, 100, 200] }), 5000)?.source).toBe("basic-offset-table"));
  test("a table that does not go up is not", () => expect(frameTableFromHeader(header({ basicOffsets: [0, 200, 100] }), 5000)).toBeNull());
  test("a table pointing past the instance is not", () => expect(frameTableFromHeader(header({ extendedOffsets: [0, 100, 9000] }), 5000)).toBeNull());
  test("native frames past the instance have no range", () => {
    const t = frameTableFromHeader({ complete: true, encapsulated: false, rows: 10, columns: 10, samplesPerPixel: 1, bitsAllocated: 8, numberOfFrames: 5, pixelDataValueOffset: 100 } as SlideHeader, 350)!;
    expect(t.range(1)).toEqual([200, 300]);
    expect(t.range(2)).toBeNull();
  });
});

const reader = (L: number, budget?: number) => {
  let fetches = 0;
  const series: any = { file: { fileId: "AAAAAAAAAAAAAAAAAAAAAA", key: "", plaintextLength: L, ciphertextLength: ciphertextLength(L) }, instances: [{ offset: 0, length: L }] };
  const resolver: any = { fetchRange: async (p: any) => (fetches++, new Uint8Array(p.ciphertextEnd - p.ciphertextStart)) };
  const decryptor: any = { decrypt: async (_s: any, p: any) => new Uint8Array(p.plaintextEnd - p.plaintextStart) };
  return { r: new SeriesReader(resolver, decryptor, series, budget ? { budgetBytes: budget } : {}), fetches: () => fetches };
};

describe("R1/R2: the slide reader", () => {
  test("a range outside the file is refused at once", async () => {
    const { r, fetches } = reader(200000);
    await expect(r.read(400, 400 + 2 ** 40)).rejects.toThrow(RangeError);
    expect(fetches()).toBe(0);
    expect(r.busy).toBe(false);
  });
  test("a read larger than the cache is fetched once, not again and again", async () => {
    const L = 20 * 1024 * 1024;
    const { r, fetches } = reader(L, 8 * 1024 * 1024);
    expect((await r.read(0, L)).length).toBe(L);
    expect(fetches()).toBe(Math.ceil(recordCount(L) / 64));
  });
});

describe("R3: counts in a slide header", () => {
  test("Number of Frames is bounded", () => {
    const file = part10("1.2.840.10008.5.1.4.1.1.77.1.6", "2.25.1", "1.2.840.10008.1.2.1", [
      element(0x0028, 0x0008, "IS", "999999999999"),
      element(0x0048, 0x0302, "UL", new Uint8Array([0xff, 0xff, 0xff, 0x7f])),
    ]);
    const h = parseSlideHeader(file, { partial: true });
    expect(h.numberOfFrames).toBe(MAX_FRAMES);
    expect(h.opticalPaths).toBeLessThanOrEqual(1024);
  });
});

describe("R4: lengths", () => {
  const golden = () => JSON.parse(readFileSync(new URL("../fixtures/golden/bundle.json", import.meta.url), "utf8"));
  const bundle = (length: number) => {
    const g = golden();
    const st = g.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
    st.series[0].instance[0].extension.find((x: any) => /instance-length/.test(x.url)).valueDecimal = length;
    return g;
  };
  test("an instance within the bound is read", () => expect(parseStudyIndex(bundle(70000)).studies.length).toBe(1));
  test("an instance longer than the bound is refused", () => expect(() => parseStudyIndex(bundle(MAX_INSTANCE_BYTES + 1))).toThrow(InvalidBundleError));
  test("a read too large to hold is refused before anything is planned", async () => {
    const L = 1e10;
    const file = { fileId: "AAAAAAAAAAAAAAAAAAAAAA", key: "A".repeat(43), plaintextLength: L, ciphertextLength: ciphertextLength(L), recordCount: recordCount(L) };
    const series: any = { id: "x", file, offset: 0, bytes: L, instances: [{ offset: 0, length: L, firstRecord: 0, lastRecord: file.recordCount - 1 }] };
    const loader = new InstanceLoader({ fetchRange: () => new Promise(() => {}) } as any, { decrypt: async () => new Uint8Array(0) } as any);
    const t = performance.now();
    await expect(loader.ciphertext(series, 0)).rejects.toThrow(RangeError);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("K3 and cty: JWE", () => {
  const key = randomKeyB64();
  test("a JWE that expands past 64 MiB is refused", async () => {
    const jwe = await encryptJwe(new Uint8Array(65 * 1024 * 1024), key);
    await expect(decryptJwe(jwe, key)).rejects.toThrow("64 MiB");
  }, 30_000);
  test("a JWE longer than the bound is refused before decrypting", () => expect(decryptJwe("a".repeat(MAX_JWE_CHARS + 1), key)).rejects.toThrow(JweError));
  test("a JWE whose content type is not FHIR is refused", async () => {
    const jwe = await encryptJwe(utf8("{}"), key, { cty: "application/smart-health-card" });
    await expect(decryptJwe(jwe, key)).rejects.toThrow("content type");
  });
  test("a FHIR JWE, or one that names no content type, is read", async () => {
    expect(await decryptJwe(await encryptJwe(utf8("{}"), key), key)).toEqual(utf8("{}"));
    expect(await decryptJwe(await encryptJwe(utf8("{}"), key, {}), key)).toEqual(utf8("{}"));
  });
});

describe("K8: file keys", () => {
  test("the same file id with another key gets its own key", async () => {
    const a = await seriesKey({ file: { fileId: "SAMEIDSAMEIDSAMEIDSAME", key: b64urlEncode(new Uint8Array(32).fill(1)) } } as any);
    const b = await seriesKey({ file: { fileId: "SAMEIDSAMEIDSAMEIDSAME", key: b64urlEncode(new Uint8Array(32).fill(2)) } } as any);
    expect(a).not.toBe(b);
  });
});

describe("K6: manifest locations", () => {
  const open = async (location: string) => {
    const key = randomKeyB64();
    const jwe = await encryptJwe(utf8("{}"), key);
    const fetch = (async (_u: string, init?: RequestInit) => (init?.method === "POST" ? new Response(JSON.stringify({ files: [{ contentType: "application/fhir+json", location }] })) : new Response(jwe))) as any;
    return new LinkResolver(encodeShlink({ url: "https://host.example/shl/x", key }), { fetch }).open();
  };
  test("a file name is accepted", async () => expect((await open("https://host.example/cap/t/bundle.jwe")).baseUrl).toBe("https://host.example/cap/t/bundle.jwe"));
  test("a folder is accepted", async () => expect((await open("https://host.example/cap/t/")).baseUrl).toBe("https://host.example/cap/t/"));
  test("a last segment that is neither is refused", () => expect(open("https://host.example/cap/t")).rejects.toThrow(LinkError));
});
