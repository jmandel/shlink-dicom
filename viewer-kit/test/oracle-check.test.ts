// bun test viewer-kit/test/oracle-check.test.ts: the per-case check verify-oracle.ts runs, with a
// stand-in decoder.
import { describe, expect, test } from "bun:test";
import { checkCase, type Decoder } from "./oracle-check";

const fb = 4; // bytes per frame
const whole = Uint8Array.from({ length: 3 * fb }, (_, i) => i);
const info = { rows: 2, columns: 2, frames: 3, totalFrames: 3, frameBytes: fb } as any;
const oracle = () => ({ dtype: "|u1", shape: [3, 2, 2], data: whole });

/** A decoder that decodes the whole file right and frame ranges as `range` says. */
function fake(range: (first: number, count: number) => Uint8Array, code = 0): Decoder {
  return {
    decode: (_b: Uint8Array, first = 0, count = 0) => {
      if (code) return { ok: false, code, message: "x", ms: 0 } as any;
      const px = count ? range(first, count) : whole;
      return { ok: true, info, pixels: px.slice().buffer, lut: null, ms: 0 } as any;
    },
    probe: () => ({ frames: 3, encapsulated: true }) as any,
  };
}

describe("frame ranges", () => {
  test("ranges equal to the whole decode pass", () => {
    const r = checkCase(fake((f, n) => whole.slice(f * fb, (f + n) * fb)), new Uint8Array(1), { expect: "decode", max_abs: 0 }, oracle);
    expect([r.outcome, r.ranges]).toEqual(["pass", "ranges-identical"]);
  });
  test("a range that returns fewer frames than asked fails", () => {
    const r = checkCase(fake((f, n) => (f === 2 ? new Uint8Array(0) : whole.slice(f * fb, (f + n) * fb))), new Uint8Array(1), { expect: "decode", max_abs: 0 }, oracle);
    expect(r.outcome).toBe("fail");
  });
});

describe("expect=error", () => {
  test("exit 2 passes, exit 3 is unsupported, any other code is a crash", () => {
    const run = (code: number) => checkCase(fake(() => whole, code), new Uint8Array(1), { expect: "error" }, null).outcome;
    expect([run(2), run(3), run(1), run(101)]).toEqual(["pass", "unsupported", "crash", "crash"]);
  });
});
