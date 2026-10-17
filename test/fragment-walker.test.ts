// bun test test/fragment-walker.test.ts: the slide reader's fragment walker (web/core/wsi.ts) finds
// frames by the reader module's start rule (shl_dicom_decode::syntax, as the packer's offset tables
// and the decoder do): a JPEG 2000 frame starts with a codestream (FF 4F) or a whole JP2 signature
// box, not with any 00 00 00 0C.
import { expect, test } from "bun:test";
import { FragmentWalker, type SlideHeader } from "../web/core/wsi";

const item = (value: number[]) => {
  const out = new Uint8Array(8 + value.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0xfffe, true);
  dv.setUint16(2, 0xe000, true);
  dv.setUint32(4, value.length, true);
  out.set(value, 8);
  return out;
};
const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

test("a fragment that only begins 00 00 00 0C continues its frame; a JP2 signature box starts one", async () => {
  const jp2 = [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
  const items = [item([0xff, 0x4f, 0xff, 0x51, 1, 2, 3, 4]), item([0, 0, 0, 0x0c, 9, 9, 9, 9, 9, 9]), item(jp2)];
  const body = cat([...items, new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0])]);
  const h = { encapsulated: true, firstFragmentOffset: 0, transferSyntax: "1.2.840.10008.1.2.4.90" } as SlideHeader;
  const w = new FragmentWalker(h, body.length);
  expect(await w.feed(body, 0)).toBe(-1);
  expect(w.starts).toEqual([0, items[0].length + items[1].length]);
});
