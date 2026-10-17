// bun test test/ingest-wrap.test.ts: the Share page wraps a bare data set in Part 10 (spec §11.1
// step 3) from its first bytes (shl-dicom-wasm part10_wrap), so a large file is never read whole.
import { beforeAll, expect, test } from "bun:test";
import { element } from "../web/checks/synthetic";
import { MemBytes, type Bytes } from "../web/share/lib/bytes";
import { Collection } from "../web/share/lib/ingest";

beforeAll(async () => {
  const helper = await import("../web/checks/shl-wasm-bun");
  await helper.useShlWasm();
});

const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

/** A bare explicit VR data set: its elements, then Pixel Data of `pixels` bytes (zeros). */
function bare(pixels: number) {
  const head = cat([
    element(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.7"),
    element(0x0008, 0x0018, "UI", "2.25.71"),
    element(0x0008, 0x0060, "CS", "OT"),
    element(0x0010, 0x0010, "PN", "BARE^FILE"),
    element(0x0020, 0x000d, "UI", "2.25.70"),
    element(0x0020, 0x000e, "UI", "2.25.70.1"),
    element(0x0028, 0x0010, "US", new Uint8Array([0, 4])),
  ]);
  const px = new Uint8Array(12);
  const dv = new DataView(px.buffer);
  dv.setUint16(0, 0x7fe0, true);
  dv.setUint16(2, 0x0010, true);
  px.set([0x4f, 0x42], 4); // OB
  dv.setUint32(8, pixels, true);
  return cat([head, px]);
}

/** A file of `size` bytes whose first bytes are `start` and the rest zeros, noting each read. */
function big(start: Uint8Array, size: number) {
  const reads: [number, number][] = [];
  const src: Bytes = {
    size,
    async read(a, b) {
      b = Math.min(b, size);
      reads.push([a, b]);
      const out = new Uint8Array(Math.max(0, b - a));
      if (a < start.length) out.set(start.subarray(a, Math.min(b, start.length)));
      return out;
    },
  };
  return { src, reads };
}

test("a 300 MB bare data set is wrapped without being read whole", async () => {
  const pixels = 300 << 20;
  const start = bare(pixels);
  const f = big(start, start.length + pixels);
  const c = new Collection();
  await c.add("big.dcm", f.src);
  await c.finish();
  expect(c.skipped).toEqual([]);
  const inst = c.list()[0].series[0].instances[0];
  const longest = Math.max(...f.reads.map(([a, b]) => b - a));
  expect(longest).toBeLessThanOrEqual(16 << 20);
  // Preamble, DICM, a new meta, then the data set's own bytes.
  const head = await inst.src.read(0, 132 + 400);
  expect(new TextDecoder().decode(head.subarray(128, 132))).toBe("DICM");
  const at = inst.src.size - f.src.size;
  expect(await inst.src.read(at, at + start.length)).toEqual(start);
  expect(inst.h.sopInstanceUid).toBe("2.25.71");
});

test("a small bare data set reads back as its wrapped Part 10 file", async () => {
  const b = bare(16);
  const file = cat([b, new Uint8Array(16)]);
  const c = new Collection();
  await c.add("small.dcm", new MemBytes(file));
  await c.finish();
  const inst = c.list()[0].series[0].instances[0];
  const all = await inst.src.read(0, inst.src.size);
  expect(new TextDecoder().decode(all.subarray(128, 132))).toBe("DICM");
  expect(all.subarray(all.length - file.length)).toEqual(file);
});
