// bun test perf-spikes/decrypt/record-decrypt.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptRecords,
  importFileKey,
  plaintextLengthOf,
  RECORD_CIPHERTEXT as RC,
  RECORD_PLAINTEXT as RP,
  RecordAuthenticationError,
  recordNonce,
} from "../../viewer-kit/src/record-decrypt.ts";

const fx = join(import.meta.dir, "fixtures");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const load = (id: string) => ({
  ct: new Uint8Array(readFileSync(join(fx, `${id}.bin`))),
  meta: JSON.parse(readFileSync(join(fx, `${id}.json`), "utf8")),
});
const vector = load("vector");
const wrist = load("wrist");
const keyOf = (m: { keyHex: string }) => importFileKey(new Uint8Array(Buffer.from(m.keyHex, "hex")));

async function rejectsAt(p: Promise<unknown>, recordIndex: number) {
  const e = await p.then(
    () => null,
    (e) => e,
  );
  expect(e).toBeInstanceOf(RecordAuthenticationError);
  expect((e as RecordAuthenticationError).recordIndex).toBe(recordIndex);
}

describe("Appendix B test vector", () => {
  test("key is the documented one", () => {
    expect(vector.meta.keyHex).toBe("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
    expect(vector.ct.length).toBe(150048);
  });

  test("ciphertext and tags match", async () => {
    expect(await sha256(vector.ct)).toBe("f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e");
    const tags = [0, 1, 2].map((i) => hex(vector.ct.subarray(Math.min(vector.ct.length, (i + 1) * RC) - 16, Math.min(vector.ct.length, (i + 1) * RC))));
    expect(tags).toEqual(["9a8421bd6740aeac5eb211cf59511b2f", "4cd810f700957e87ae68edc29e40caf9", "cf980ddc661684644fa17e5b00b08819"]);
  });

  for (const concurrency of [1, 2, 8, 64]) {
    test(`whole file decrypts (concurrency ${concurrency})`, async () => {
      const pt = await decryptRecords(await keyOf(vector.meta), vector.ct, 0, { concurrency, filePlaintextLength: 150000 });
      expect(pt.length).toBe(150000);
      expect(await sha256(pt)).toBe("02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b");
      expect(pt.every((b, k) => b === k % 251)).toBe(true);
    });
  }

  test("range read of instance 2 (records 1–2)", async () => {
    const pt = await decryptRecords(await keyOf(vector.meta), vector.ct.subarray(65536, 150048), 1, { filePlaintextLength: 150000 });
    const inst2 = pt.subarray(70000 - RP, 70000 - RP + 80000);
    expect(inst2.every((b, k) => b === (70000 + k) % 251)).toBe(true);
  });

  test("window returns exactly instance 2 from records 1–2", async () => {
    const pt = await decryptRecords(await keyOf(vector.meta), vector.ct.subarray(65536, 150048), 1, {
      filePlaintextLength: 150000,
      window: { start: 70000 - RP, length: 80000 },
    });
    expect(pt.length).toBe(80000);
    expect(pt.byteOffset).toBe(0);
    expect(pt.buffer.byteLength).toBe(80000); // transferable as is
    expect(pt.every((b, k) => b === (70000 + k) % 251)).toBe(true);
  });

  test("window still verifies records outside it", async () => {
    const t = vector.ct.slice();
    t[10] ^= 1; // record 0, outside the window
    await rejectsAt(decryptRecords(await keyOf(vector.meta), t, 0, { window: { start: 70000, length: 100 } }), 0);
  });

  test("window outside the plaintext is refused", async () => {
    expect(decryptRecords(await keyOf(vector.meta), vector.ct, 0, { window: { start: 149990, length: 11 } })).rejects.toThrow(RangeError);
  });

  test("writes into a caller's buffer", async () => {
    const output = new Uint8Array(200000).fill(7);
    const pt = await decryptRecords(await keyOf(vector.meta), vector.ct, 0, { output });
    expect(pt.buffer).toBe(output.buffer);
    expect(pt.length).toBe(150000);
    expect(output[150000]).toBe(7);
  });
});

describe("tampering is rejected", () => {
  const key = () => keyOf(vector.meta);
  const P = { filePlaintextLength: 150000 };

  test("flipped ciphertext bit", async () => {
    const t = vector.ct.slice();
    t[70000] ^= 1;
    await rejectsAt(decryptRecords(await key(), t, 0), 1);
  });

  test("flipped tag bit", async () => {
    const t = vector.ct.slice();
    t[RC - 1] ^= 0x80;
    await rejectsAt(decryptRecords(await key(), t, 0), 0);
  });

  test("swapped records", async () => {
    const t = vector.ct.slice();
    t.set(vector.ct.subarray(RC, 2 * RC), 0);
    t.set(vector.ct.subarray(0, RC), RC);
    const e = await decryptRecords(await key(), t, 0, { concurrency: 1 }).catch((e) => e);
    expect(e).toBeInstanceOf(RecordAuthenticationError);
  });

  test("record presented at the wrong index", async () => {
    await rejectsAt(decryptRecords(await key(), vector.ct.subarray(RC), 2, { concurrency: 1 }), 2);
  });

  test("final record truncated by one byte", async () => {
    await rejectsAt(decryptRecords(await key(), vector.ct.subarray(0, vector.ct.length - 1), 0, P), 2);
  });

  test("a non-final record cut short (needs filePlaintextLength)", async () => {
    // Without the series length this would just fail the tag; with it, it fails before any call.
    await rejectsAt(decryptRecords(await key(), vector.ct.subarray(0, 2 * RC - 100), 0, P), 1);
  });

  test("a whole missing final record is a valid range read, so whole-file reads compare lengths", async () => {
    // Records 0–1 alone are a legitimate range read (§9.3); only the caller knows it asked for all.
    const cut = vector.ct.subarray(0, 2 * RC);
    expect((await decryptRecords(await key(), cut, 0, P)).length).toBe(2 * RP);
    expect(plaintextLengthOf(cut.length)).not.toBe(150000);
  });

  test("extended past the end", async () => {
    const t = new Uint8Array(vector.ct.length + 100);
    t.set(vector.ct);
    await rejectsAt(decryptRecords(await key(), t, 0, P), 2);
  });

  test("a fragment shorter than a tag", async () => {
    await rejectsAt(decryptRecords(await key(), vector.ct.subarray(0, RC + 10), 0), 1);
  });

  test("wrong key", async () => {
    const other = await importFileKey(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
    const e = await decryptRecords(other, vector.ct, 0).catch((e) => e);
    expect(e).toBeInstanceOf(RecordAuthenticationError);
  });

  test("output is zeroed after a failure", async () => {
    const t = vector.ct.slice();
    t[2 * RC + 5] ^= 1; // record 2 fails, records 0–1 decrypt first
    const output = new Uint8Array(150000);
    await rejectsAt(decryptRecords(await key(), t, 0, { output, concurrency: 1 }), 2);
    expect(output.every((b) => b === 0)).toBe(true);
  });
});

describe("real series file (wrist-low-res, 3 Part 10 instances)", () => {
  test("decrypts to the original DICOM bytes", async () => {
    const pt = await decryptRecords(await keyOf(wrist.meta), wrist.ct, 0, { filePlaintextLength: wrist.meta.plaintextLength });
    expect(await sha256(pt)).toBe(wrist.meta.plaintextSha256);
    let off = 0;
    for (const n of wrist.meta.instanceLengths) {
      expect(new TextDecoder().decode(pt.subarray(off + 128, off + 132))).toBe("DICM");
      off += n;
    }
  });

  test("a flipped bit in a middle record is rejected", async () => {
    const t = wrist.ct.slice();
    t[40 * RC + 123] ^= 4;
    await rejectsAt(decryptRecords(await keyOf(wrist.meta), t, 0), 40);
  });
});

describe("helpers", () => {
  test("series key is non-extractable and decrypt-only", async () => {
    const k = await keyOf(vector.meta);
    expect(k.extractable).toBe(false);
    expect(k.usages).toEqual(["decrypt"]);
    expect(crypto.subtle.exportKey("raw", k)).rejects.toThrow();
    expect(importFileKey(new Uint8Array(16))).rejects.toThrow();
  });

  test("nonce is uint96_be(i)", () => {
    expect(hex(recordNonce(0))).toBe("000000000000000000000000");
    expect(hex(recordNonce(2))).toBe("000000000000000000000002");
    expect(hex(recordNonce(0x1_0000_0001))).toBe("000000000000000100000001");
    expect(hex(recordNonce(Number.MAX_SAFE_INTEGER))).toBe("00000000001fffffffffffff");
    expect(() => recordNonce(-1)).toThrow();
  });

  test("plaintextLengthOf", () => {
    expect(plaintextLengthOf(150048)).toBe(150000);
    expect(plaintextLengthOf(RC)).toBe(RP);
    expect(() => plaintextLengthOf(RC + 3)).toThrow();
  });
});
