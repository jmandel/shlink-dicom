// bun test test/reader-limits.test.ts: what a host, a link or a file can make the browser reader
// take in (review dsmax items cr-D3/cl-D4, cr-D5, cr-D6, cl-D6, cl-D3).
import { describe, expect, test } from "bun:test";
import { LinkResolver } from "../web/core/resolver";
import { encodeShlink, parseShlink } from "../web/core/shlink";
import { encryptJwe, MAX_JWE_CHARS, randomKeyB64 } from "../web/core/jwe";
import { utf8 } from "../web/core/b64";
import { buildPyramid, MAX_LEVEL_TILES } from "../web/core/wsi";
import { MemBytes } from "../web/share/lib/bytes";
import { zipEntries } from "../web/share/lib/ingest";
import { memoryStager } from "../web/share/lib/stage";

/** A body of `total` bytes, made 1 MiB at a time as it is read; `pulled()` says how much was made. */
function body(total: number, fill = 0) {
  let made = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (made >= total) return c.close();
      const n = Math.min(1 << 20, total - made);
      made += n;
      c.enqueue(new Uint8Array(n).fill(fill));
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => made };
}

const KEY = randomKeyB64();
const direct = (f: typeof fetch) => {
  const r = new LinkResolver(encodeShlink({ url: "https://host.example/f/bundle.jwe", key: KEY, flag: "U" }), { fetch: f });
  (r as any).baseUrl = "https://host.example/f/bundle.jwe";
  return r;
};
const plan = { fileId: "F", ciphertextStart: 65536, ciphertextEnd: 131072, rangeHeader: "bytes=65536-131071", firstRecord: 1, lastRecord: 1 } as any;

describe("file reads take what the plan names", () => {
  test("a host that answers a range with the whole file: the read stops once the range is in", async () => {
    const b = body(200 << 20);
    const out = await direct((async () => new Response(b.stream, { status: 200 })) as any).fetchRange(plan);
    expect(out.byteLength).toBe(65536);
    expect(b.pulled()).toBeLessThanOrEqual(4 << 20);
  });
  test("a range answer longer than the range is refused without reading it all", async () => {
    const b = body(200 << 20);
    await expect(direct((async () => new Response(b.stream, { status: 206 })) as any).fetchRange(plan)).rejects.toThrow(/more than/);
    expect(b.pulled()).toBeLessThanOrEqual(4 << 20);
  });
  test("a range answer of the right length is read", async () => {
    const out = await direct((async () => new Response(new Uint8Array(65536).fill(3), { status: 206 })) as any).fetchRange(plan);
    expect(out.byteLength).toBe(65536);
    expect(out[65535]).toBe(3);
  });
});

describe("the Bundle and the manifest are read up to a limit", () => {
  test("a Bundle longer than the limit is refused as it arrives", async () => {
    const b = body(MAX_JWE_CHARS + (16 << 20), 0x41);
    const r = new LinkResolver(encodeShlink({ url: "https://host.example/f/bundle.jwe", key: KEY, flag: "U" }), { fetch: (async () => new Response(b.stream)) as any });
    await expect(r.open()).rejects.toThrow(/too large/);
    expect(b.pulled()).toBeLessThanOrEqual(MAX_JWE_CHARS + (2 << 20));
  });
  test("a manifest longer than the limit is refused as it arrives", async () => {
    const b = body(MAX_JWE_CHARS + (16 << 20), 0x20);
    const r = new LinkResolver(encodeShlink({ url: "https://host.example/m", key: KEY }), { fetch: (async () => new Response(b.stream)) as any });
    await expect(r.open()).rejects.toThrow(/too large/);
    expect(b.pulled()).toBeLessThanOrEqual(MAX_JWE_CHARS + (2 << 20));
  });
  test("the manifest's FHIR entry is the Bundle, not the first entry with a location", async () => {
    const jwe = await encryptJwe(utf8(JSON.stringify({ resourceType: "Bundle", type: "collection", entry: [] })), KEY);
    const seen: string[] = [];
    const f = async (url: string) => {
      seen.push(String(url));
      if (String(url) === "https://host.example/m") {
        return Response.json({ files: [{ contentType: "application/smart-health-card", location: "https://elsewhere.example/card" }, { contentType: "application/fhir+json;fhirVersion=4.0.1", location: "https://host.example/cap/x/bundle.jwe" }] });
      }
      return new Response(jwe);
    };
    const r = new LinkResolver(encodeShlink({ url: "https://host.example/m", key: KEY }), { fetch: f as any });
    const opened = await r.open();
    expect(opened.baseUrl).toBe("https://host.example/cap/x/bundle.jwe");
    expect(seen.some((u) => u.startsWith("https://elsewhere.example"))).toBe(false);
  });
});

describe("links SMART Health Links does not allow", () => {
  test("a link to the file itself with a passcode is refused", () => {
    expect(() => parseShlink(encodeShlink({ url: "https://h/x", key: KEY, flag: "PU" }))).toThrow(/cannot need a passcode/);
  });
  test("a version above 1 is refused; 1 and none are read", () => {
    expect(() => parseShlink(encodeShlink({ url: "https://h/x", key: KEY, v: 2 }))).toThrow(/version/);
    expect(parseShlink(encodeShlink({ url: "https://h/x", key: KEY, v: 1 })).v).toBe(1);
    expect(parseShlink(encodeShlink({ url: "https://h/x", key: KEY })).v).toBeUndefined();
  });
  test("neither is requested from the host", async () => {
    let asked = 0;
    const f = (async () => (asked++, new Response("{}"))) as any;
    for (const p of [{ flag: "PU" }, { v: 2 }]) {
      expect(() => new LinkResolver(encodeShlink({ url: "https://h/x", key: KEY, ...p }), { fetch: f })).toThrow();
    }
    expect(asked).toBe(0);
  });
});

describe("slides", () => {
  const header = (over: any) => ({
    transferSyntax: "1.2.840.10008.1.2.4.50", sopClassUid: "1.2.840.10008.5.1.4.1.1.77.1.6", sopInstanceUid: "2.25.1", modality: "SM",
    imageType: ["ORIGINAL", "PRIMARY", "VOLUME"], flavor: "VOLUME", rows: 1, columns: 1, samplesPerPixel: 3, photometric: "YBR_FULL_422",
    planarConfiguration: 0, bitsAllocated: 8, bitsStored: 8, highBit: 7, pixelRepresentation: 0, numberOfFrames: 1,
    totalColumns: 1, totalRows: 1, dimensionOrganization: "TILED_FULL", focalPlanes: 1, opticalPaths: 1, pixelSpacing: null,
    planePositions: null, frameZ: null, framePath: null, frameSegment: null, sharedZ: null, sharedPath: null, paths: [],
    origin: null, orientation: null, imagedVolumeWidth: null, segments: [], extendedOffsets: null, extendedLengths: null,
    ...over,
  });
  test("a level with more tiles than a viewer reads is refused before any memory is set aside for it", () => {
    expect(() => buildPyramid([header({ rows: 1, columns: 1, totalColumns: 1 << 16, totalRows: 1 << 16 }) as any])).toThrow(/more than this viewer reads/);
  });
  test("a level at the limit is read", () => {
    const side = Math.sqrt(MAX_LEVEL_TILES);
    expect(buildPyramid([header({ rows: 256, columns: 256, totalColumns: 256 * side, totalRows: 256 * side }) as any]).levels.length).toBe(1);
  });
});

describe("archives", () => {
  /** A ZIP of one deflated member that says it is `says` bytes. */
  async function zip(data: Uint8Array, says: number) {
    const comp = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const name = utf8("a.dcm");
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, says, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, says, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true);
    cd.set(name, 46);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, cd.length, true);
    ev.setUint32(16, lh.length + comp.length, true);
    const out = new Uint8Array(lh.length + comp.length + cd.length + eocd.length);
    out.set(lh, 0);
    out.set(comp, lh.length);
    out.set(cd, lh.length + comp.length);
    out.set(eocd, lh.length + comp.length + cd.length);
    return new MemBytes(out);
  }
  const all = async (src: MemBytes) => {
    const out = [];
    for await (const e of zipEntries(src, memoryStager())) out.push(e);
    return out;
  };
  test("a ZIP member that inflates past the size the ZIP gives is refused", async () => {
    await expect(all(await zip(new Uint8Array(8 << 20), 1000))).rejects.toThrow(/larger than the ZIP says/);
  });
  test("a ZIP member of the size it says is read", async () => {
    const [e] = await all(await zip(new Uint8Array(5000).fill(9), 5000));
    expect(e.src.size).toBe(5000);
  });
});
