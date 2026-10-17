// bun test test/video-payload.test.ts: the encapsulated video stream (web/core/video.ts
// videoPayload) ends cleanly when the data stop at an item boundary without the sequence delimiter,
// and refuses data cut inside an item header or value.
import { describe, expect, test } from "bun:test";
import type { SeriesEntry } from "../web/core/bundle";
import { RECORD_PLAINTEXT, type RangePlan } from "../web/core/range";
import { MediaHeaderError, parseMediaHeader, videoPayload } from "../web/core/video";
import { element, part10 } from "../web/checks/synthetic";

const H264 = "1.2.840.10008.5.1.4.1.1.77.1.1.1";
const us = (n: number) => new Uint8Array([n & 0xff, n >> 8]);
const item = (v: Uint8Array) => {
  const h = new Uint8Array(8 + v.length);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, 0xfffe, true);
  dv.setUint16(2, 0xe000, true);
  dv.setUint32(4, v.length, true);
  h.set(v, 8);
  return h;
};

/** A video instance: Pixel Data with an empty Basic Offset Table and `frags`, then `tail`. */
function instance(frags: Uint8Array[], tail: Uint8Array): Uint8Array {
  const ds = [
    element(0x0008, 0x0016, "UI", H264),
    element(0x0028, 0x0002, "US", us(3)),
    element(0x0028, 0x0008, "IS", "1"),
    element(0x0028, 0x0010, "US", us(16)),
    element(0x0028, 0x0011, "US", us(16)),
    new Uint8Array([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0, 0, 0xff, 0xff, 0xff, 0xff]),
    item(new Uint8Array(0)),
    ...frags.map(item),
    tail,
  ];
  return part10(H264, "2.25.7", "1.2.840.10008.1.2.4.102", ds);
}

/** The stream of a file of plaintext bytes, through stand-ins for the loader and decryptor. */
async function payload(bytes: Uint8Array): Promise<Uint8Array> {
  const series = {
    id: "f@0",
    file: { fileId: "f", plaintextLength: bytes.length, ciphertextLength: 0 },
    instances: [{ offset: 0, length: bytes.length, sopClass: H264, uid: "2.25.7" }],
  } as unknown as SeriesEntry;
  const share = {
    loader: {
      range: async (_s: SeriesEntry, plan: RangePlan) => bytes.slice(plan.firstRecord * RECORD_PLAINTEXT, Math.min(bytes.length, (plan.lastRecord + 1) * RECORD_PLAINTEXT)),
      report() {},
    },
    decryptor: { decrypt: async (_s: SeriesEntry, plan: RangePlan, ct: Uint8Array) => ct.slice(plan.plaintextStart - plan.firstRecord * RECORD_PLAINTEXT, plan.plaintextEnd - plan.firstRecord * RECORD_PLAINTEXT) },
  } as any;
  const header = parseMediaHeader(bytes);
  const parts: Uint8Array[] = [];
  for await (const p of videoPayload(share, series, 0, header, { chunk: 64 })) parts.push(p);
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

const a = Uint8Array.from({ length: 300 }, (_, k) => k & 0xff), b = Uint8Array.from({ length: 202 }, (_, k) => 255 - (k & 0xff));
const both = new Uint8Array([...a, ...b]);
const END = new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);

describe("videoPayload", () => {
  test("with the sequence delimiter", async () => expect(await payload(instance([a, b], END))).toEqual(both));
  test("ending at an item boundary without the delimiter", async () => expect(await payload(instance([a, b], new Uint8Array(0)))).toEqual(both));
  test("cut inside an item header", () => expect(payload(instance([a, b], new Uint8Array([0xfe, 0xff, 0x00])))).rejects.toThrow(MediaHeaderError));
  test("cut inside a fragment", () => {
    const whole = instance([a, b], new Uint8Array(0));
    return expect(payload(whole.subarray(0, whole.length - 10))).rejects.toThrow(MediaHeaderError);
  });
});
