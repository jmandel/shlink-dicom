// bun test test/upload-job.test.ts: the saved upload job (web/share/lib/upload.ts) is dropped once
// its share has expired.
import { beforeEach, describe, expect, test } from "bun:test";
import { loadJob, saveJob, type UploadJob } from "../web/share/lib/upload";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
};
beforeEach(() => store.clear());

const job = (expiresAt: number) =>
  ({ apiBase: "https://x", sid: "s", token: "t", ownerKey: "k", source: { kind: "files" }, addOffsetTables: false, compress: null, recipient: null, hasPasscode: true, exp: null, expiresAt, longLived: false, title: "CT", startedAt: 1 }) as UploadJob;

describe("the saved upload job", () => {
  test("is kept until its share expires", () => {
    saveJob(job(2000));
    expect(loadJob(1999)?.sid).toBe("s");
  });
  test("is cleared once its share has expired", () => {
    saveJob(job(2000));
    expect(loadJob(2000)).toBeNull();
    expect(store.size).toBe(0);
  });
  test("a job saved without an expiry is cleared", () => {
    const { expiresAt: _e, ...old } = job(2000);
    store.set("shl-dicom-upload-job", JSON.stringify(old));
    expect(loadJob(1)).toBeNull();
    expect(store.size).toBe(0);
  });
});
