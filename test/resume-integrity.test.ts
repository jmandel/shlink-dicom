// bun test test/resume-integrity.test.ts: continuing an upload after a reload (web/share/lib/upload.ts)
// never encrypts different plaintext under a key and record number whose ciphertext may have left
// the browser. A file edited in the middle (same size, same first and last 64 KiB) starts again
// under a new id and key; an unchanged one continues where the server got to.
import { describe, expect, test } from "bun:test";
import { ApiError } from "../web/share/lib/api";
import { MemBytes } from "../web/share/lib/bytes";
import { SentLedger, uploadFiles, type SentHashes } from "../web/share/lib/upload";
import { quickId } from "../web/share/lib/handles";
import { b64urlDecode } from "../web/core/b64";
import { randomKeyB64 } from "../web/core/jwe";
import { RECORD_CIPHERTEXT as RC, RECORD_PLAINTEXT as RP, recordCount, recordNonce } from "../web/core/range";

const N = 10;
const P = N * RP - 1000;
const v1 = crypto.getRandomValues(new Uint8Array(P));
const v2 = v1.slice();
for (const r of [2, 6]) v2[r * RP + 30000] ^= 0xff; // same-size edits in the middle of records 2 and 6

/** A stand-in server. `seen` keeps, per file, every ciphertext byte that reached it, to catch a byte sent twice with different values. */
function server() {
  const files = new Map<string, { bytes: number[]; length: number | null; seen: Map<number, number> }>();
  let reuse = 0;
  let cutAt: number | null = null; // the next append is cut here (a reload)
  let lie = false; // report offset 0 although bytes are held
  const api: any = {
    uploadOffset: async (id: string) => {
      const f = files.get(id);
      if (!f) return null;
      return { offset: lie ? 0 : f.bytes.length, length: f.length, complete: f.length !== null && f.bytes.length === f.length };
    },
    createUpload: async (id: string, length: number | null) => void files.set(id, { bytes: [], length, seen: new Map() }),
    deleteFile: async (id: string) => void files.delete(id),
    appendUpload: async (id: string, from: number, body: Uint8Array, _done: boolean, _p: unknown, length: number | null) => {
      lie = false;
      const f = files.get(id)!;
      if (length !== null) f.length = length;
      const take = cutAt !== null ? Math.max(0, Math.min(body.length, cutAt - from)) : body.length;
      for (let i = 0; i < take; i++) {
        const at = from + i;
        const was = f.seen.get(at);
        if (was !== undefined && was !== body[i]) reuse++;
        f.seen.set(at, body[i]);
      }
      f.bytes.length = from;
      for (let i = 0; i < take; i++) f.bytes.push(body[i]);
      if (cutAt !== null) {
        cutAt = null;
        throw new ApiError(400, "reload");
      }
      return { offset: f.bytes.length, complete: f.length === f.bytes.length };
    },
  };
  return {
    api,
    files,
    reused: () => reuse,
    cut: (n: number) => (cutAt = n),
    lie: () => (lie = true),
  };
}

const plan = (bytes: Uint8Array, fileId: string, key: string) => ({ study: {} as any, instances: [{ src: new MemBytes(bytes) }] as any, fileId, key, plaintextLength: bytes.length, records: recordCount(bytes.length) });

async function decrypts(stored: number[], key: string, want: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", b64urlDecode(key), "AES-GCM", false, ["decrypt"]);
  const ct = Uint8Array.from(stored);
  const out = new Uint8Array(want.length);
  for (let r = 0; r * RC < ct.length; r++) {
    out.set(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: recordNonce(r) }, k, ct.subarray(r * RC, Math.min(ct.length, (r + 1) * RC)))), r * RP);
  }
  return out.every((b, i) => b === want[i]);
}

/** Uploads v1 until cut at `cut`, then continues with `second` as a reload would (same saved job). */
async function reload(cut: number, second: Uint8Array, o: { lie?: boolean } = {}) {
  const s = server();
  const sent: SentHashes = {};
  const ledger = () => new SentLedger(sent, () => true);
  const key = randomKeyB64();
  s.cut(cut);
  await uploadFiles(s.api, [plan(v1, "F", key)], () => {}, () => {}, { fresh: true, ledger: ledger() }).catch((e) => {
    if (e.message !== "reload") throw e;
  });
  const held = s.files.get("F")!.bytes.length;
  if (o.lie) s.lie();
  const p = plan(second, "F", key);
  let rekeyed = 0;
  const sentAfter: number[] = [];
  const api = { ...s.api, appendUpload: (...a: any[]) => (sentAfter.push(a[2].length), s.api.appendUpload(...a)) };
  await uploadFiles(api, [p], () => {}, () => {}, { ledger: ledger(), rekeyed: async () => void rekeyed++ });
  const f = s.files.get(p.fileId)!;
  return { s, p, held, rekeyed, resent: sentAfter.reduce((a, b) => a + b, 0), ok: await decrypts(f.bytes, p.key, second), complete: f.bytes.length === f.length };
}

describe("continuing an upload after a reload", () => {
  test("the edit is one a quick id does not see", async () => {
    expect(await quickId(new File([v1], "a.dcm"))).toBe(await quickId(new File([v2], "a.dcm")));
  });
  for (const [name, cut, lie] of [
    ["cut mid-record", Math.round(6.5 * RC), false],
    ["cut on a record boundary", 7 * RC, false],
    ["a server that reports less than it holds", 7 * RC, true],
  ] as const) {
    test(`a file edited in the middle starts again under a new id and key (${name})`, async () => {
      const r = await reload(cut, v2, { lie });
      expect(r.s.reused()).toBe(0);
      expect(r.p.fileId).not.toBe("F");
      expect(r.rekeyed).toBe(1);
      expect(r.s.files.has("F")).toBe(false);
      expect(r.ok && r.complete).toBe(true);
    });
  }
  test("an unchanged file continues from where the server got to", async () => {
    const r = await reload(Math.round(6.5 * RC), v1);
    expect(r.s.reused()).toBe(0);
    expect(r.p.fileId).toBe("F");
    expect(r.rekeyed).toBe(0);
    expect(r.resent).toBe(P + 16 * N - r.held);
    expect(r.ok && r.complete).toBe(true);
  });
  test("a file of another length starts again", async () => {
    const shorter = v1.slice(0, P - RP);
    const r = await reload(3 * RC, shorter);
    expect(r.s.reused()).toBe(0);
    expect(r.p.fileId).not.toBe("F");
    expect(r.ok && r.complete).toBe(true);
  });
  test("without a record of what was sent, a file the server has part of starts again", async () => {
    const s = server();
    const key = randomKeyB64();
    s.cut(3 * RC);
    await uploadFiles(s.api, [plan(v1, "F", key)], () => {}, () => {}, { fresh: true, ledger: new SentLedger({}, () => true) }).catch(() => {});
    const p = plan(v2, "F", key);
    await uploadFiles(s.api, [p], () => {}, () => {}, { ledger: new SentLedger({}, () => true) });
    expect(s.reused()).toBe(0);
    expect(p.fileId).not.toBe("F");
  });
});
