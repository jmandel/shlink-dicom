// bun test test/upload-complete.test.ts: an upload whose bytes all arrived but which the server
// did not complete (its last step failed, e.g. S3 CompleteMultipartUpload) is completed with an
// empty append that says Upload-Complete: ?1; a failure of that append is retried like any other.
import { describe, expect, test } from "bun:test";
import { ApiError } from "../web/share/lib/api";
import { MemBytes } from "../web/share/lib/bytes";
import type { PackedFile } from "../web/share/lib/pack";
import { ciphertextLength } from "../web/core/range";
import { randomKeyB64 } from "../web/core/jwe";
import { recordCount } from "../web/core/range";
import { SentLedger, uploadFiles } from "../web/share/lib/upload";

function file(): PackedFile {
  const bytes = new Uint8Array(100_000).map((_, i) => i & 0xff);
  return { study: {} as any, instances: [{ src: new MemBytes(bytes) } as any], fileId: "f1", key: randomKeyB64(), plaintextLength: bytes.length, records: recordCount(bytes.length) };
}

/** A server that holds the whole file, not completed; `failures` appends fail with 503 first. */
function server(size: number, failures: number) {
  const state = { offset: size, complete: false };
  const appends: { offset: number; length: number; complete: boolean }[] = [];
  const api = {
    uploadOffset: async () => ({ offset: state.offset, length: size, complete: state.complete }),
    createUpload: async () => {
      throw new Error("the upload exists: it must not be created again");
    },
    appendUpload: async (_id: string, offset: number, bytes: Uint8Array, complete: boolean) => {
      appends.push({ offset, length: bytes.length, complete });
      if (failures-- > 0) throw new ApiError(503, "CompleteMultipartUpload failed");
      if (complete && offset + bytes.length === size) state.complete = true;
      return { offset: offset + bytes.length, complete: state.complete };
    },
  };
  return { api: api as any, state, appends };
}

/** The saved job's record of what was sent: the whole file, as it was before the reload. */
async function sentAll(p: PackedFile) {
  const ledger = new SentLedger({}, () => true);
  await ledger.cover(p, p.records, p.records);
  return ledger;
}

describe("an upload whose last step failed", () => {
  test("is completed with an empty append", async () => {
    const p = file(), size = ciphertextLength(p.plaintextLength);
    const s = server(size, 0);
    let last: any = null;
    await uploadFiles(s.api, [p], (u) => (last = u), () => {}, { ledger: await sentAll(p) });
    expect(s.appends).toEqual([{ offset: size, length: 0, complete: true }]);
    expect(s.state.complete).toBe(true);
    expect(last.filesDone).toBe(1);
  });
  test("a failed completing append is retried", async () => {
    const p = file(), size = ciphertextLength(p.plaintextLength);
    const s = server(size, 1);
    const conn: string[] = [];
    await uploadFiles(s.api, [p], () => {}, (c) => conn.push(c.state), { ledger: await sentAll(p) });
    expect(s.appends).toEqual([
      { offset: size, length: 0, complete: true },
      { offset: size, length: 0, complete: true },
    ]);
    expect(s.state.complete).toBe(true);
    expect(conn).toContain("retrying");
  }, 10_000);
});
