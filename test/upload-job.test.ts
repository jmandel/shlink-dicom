// bun test test/upload-job.test.ts: saved upload jobs and staged files (web/share/lib/upload.ts,
// stage.ts) with uploads in more than one tab. Each share's job is kept under its own key and
// dropped once its share has expired; a tab neither offers nor clears what another tab is using.
import { beforeEach, describe, expect, test } from "bun:test";
import { clearJob, freeJobs, holdJob, loadJob, loadJobs, releaseJob, saveJob, type UploadJob } from "../web/share/lib/upload";
import { clearStaging, openStager } from "../web/share/lib/stage";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

/** Web Locks shared by every "tab" (this test is one tab; `otherTab` takes locks as another would). */
const held = new Set<string>();
const locks = {
  async request(name: string, o: { ifAvailable?: boolean }, cb: (l: unknown) => unknown) {
    if (held.has(name)) return cb(null);
    held.add(name);
    try {
      return await cb({ name });
    } finally {
      held.delete(name);
    }
  },
  async query() {
    return { held: [...held].map((name) => ({ name })) };
  },
};
const otherTab = (name: string) => held.add(name);

/** An origin-private file system: directories of files. */
class Dir {
  kind = "directory" as const;
  kids = new Map<string, Dir | { kind: "file" }>();
  async getDirectoryHandle(n: string) {
    if (!this.kids.has(n)) this.kids.set(n, new Dir());
    return this.kids.get(n) as Dir;
  }
  async getFileHandle(n: string) {
    if (!this.kids.has(n)) this.kids.set(n, { kind: "file", createWritable: () => ({ write: async () => {}, close: async () => {} }), getFile: async () => new File([], n) } as any);
    return this.kids.get(n);
  }
  async *entries() {
    yield* this.kids.entries();
  }
  async removeEntry(n: string) {
    this.kids.delete(n);
  }
}
let root = new Dir();
Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
Object.defineProperty(globalThis.navigator, "storage", { value: { getDirectory: async () => root }, configurable: true });
const staged = async () => [...(await root.getDirectoryHandle("share-staging")).kids.keys()].filter((k) => !k.startsWith(".")).sort();

beforeEach(() => {
  store.clear();
  held.clear();
  root = new Dir();
});

const job = (sid: string, expiresAt = 2e9, startedAt = 1) =>
  ({ apiBase: "https://x", sid, token: "t", ownerKey: "k", source: { kind: "portal", stage: `stage-${sid}` }, addOffsetTables: false, compress: null, recipient: null, hasPasscode: true, exp: null, expiresAt, longLived: false, title: "CT", startedAt }) as UploadJob;

describe("the saved upload job", () => {
  test("is kept until its share expires", () => {
    saveJob(job("s", 2000));
    expect(loadJob("s", 1999)?.sid).toBe("s");
  });
  test("is cleared once its share has expired", () => {
    saveJob(job("s", 2000));
    expect(loadJob("s", 2000)).toBeNull();
    expect(store.size).toBe(0);
  });
  test("a job saved without an expiry is cleared", () => {
    const { expiresAt: _e, ...old } = job("s");
    store.set("shl-dicom-upload-job:s", JSON.stringify(old));
    expect(loadJob("s", 1)).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe("uploads in two tabs", () => {
  test("each keeps its own saved job", () => {
    saveJob(job("a", 2e9, 1));
    saveJob(job("b", 2e9, 2));
    expect(loadJobs().map((j) => j.sid)).toEqual(["b", "a"]);
  });
  test("finishing one clears only its own job", () => {
    saveJob(job("a"));
    saveJob(job("b"));
    clearJob("a");
    expect(loadJobs().map((j) => j.sid)).toEqual(["b"]);
  });
  test("a job another tab is working on is not offered", async () => {
    saveJob(job("a", 2e9, 1));
    saveJob(job("b", 2e9, 2));
    otherTab("shl-dicom-upload:b");
    expect((await freeJobs()).map((j) => j.sid)).toEqual(["a"]);
    expect(await holdJob("b")).toBe(false);
    expect(await holdJob("a")).toBe(true);
    expect((await freeJobs()).map((j) => j.sid)).toEqual(["a"]);
    releaseJob("a");
  });
  test("cleanup leaves files another tab is staging", async () => {
    await openStager("mine");
    const base = await root.getDirectoryHandle("share-staging");
    // Another tab's session (it holds the lock), and one of a tab that closed (no lock, no job).
    await base.getDirectoryHandle("theirs");
    otherTab("shl-dicom-stage:theirs");
    await base.getDirectoryHandle("old");
    await clearStaging();
    expect(await staged()).toEqual(["theirs"]);
  });
  test("cleanup keeps what a saved job continues from", async () => {
    await openStager("stage-a");
    held.clear();
    saveJob(job("a"));
    await clearStaging(...loadJobs().map((j) => j.source.stage));
    expect(await staged()).toEqual(["stage-a"]);
  });
});
