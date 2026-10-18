import { describe, expect, test } from "bun:test";
import { ExportJobs, ExportScopeRecords } from "../web/core/export-jobs";
import { writePlannedZip, planExport } from "../web/core/export";
import { FetchPriority, InstanceLoader } from "../web/core/loader";
import { SeriesReader } from "../web/core/wsi-source";
import { LoaderBytes } from "../web/core/frames";
import { planInstances, RECORD_CIPHERTEXT as CT, RECORD_PLAINTEXT as PT, type RangePlan } from "../web/core/range";
import type { SeriesEntry } from "../web/core/bundle";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function series(id: string, n = 10, offset = 0): SeriesEntry {
  return { id, uid: id, offset, bytes: n * PT,
    file: { fileId: id, key: "test", recordCount: n, plaintextLength: offset + n * PT, ciphertextLength: (offset / PT + n) * CT },
    instances: Array.from({ length: n }, (_, i) => ({ uid: `${id}.${i}`, offset: offset + i * PT, length: PT })) } as SeriesEntry;
}
function harness() {
  const jobs = new ExportJobs();
  const calls: { plan: RangePlan; signal?: AbortSignal; finish(): void; fail(): void; part(n: number): void }[] = [];
  const resolver = { fetchRange: (plan: RangePlan, signal?: AbortSignal, progress?: any) => new Promise<Uint8Array>((resolve, reject) => {
    const bytes = new Uint8Array(plan.ciphertextEnd - plan.ciphertextStart).fill(plan.firstRecord + 1);
    signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true });
    calls.push({ plan, signal, finish: () => resolve(bytes), fail: () => reject(new Error("network")), part: (n) => progress?.(n, bytes.length, bytes) });
  }) };
  const decryptor = { decrypt: async (_s: SeriesEntry, p: RangePlan, bytes: Uint8Array) => bytes.slice(0, p.plaintextEnd - p.plaintextStart) };
  const loader = new InstanceLoader(resolver as any, decryptor, { concurrency: 3, admission: jobs });
  return { jobs, calls, loader, resolver, decryptor };
}
function focus(h: ReturnType<typeof harness>, s: SeriesEntry, lo: number, hi: number) {
  const job = h.jobs.create("archive.zip");
  job.seal(h.resolver, [{ file: s.file, lo, hi }]);
  return job;
}

describe("export scope and focus", () => {
  test("half-open union, touching intervals, shared files and distinct source/key contexts", () => {
    const source = {}, a = series("x");
    const u = new ExportScopeRecords(source, [{ file: a.file, lo: 4, hi: 7 }, { file: a.file, lo: 1, hi: 4 }, { file: a.file, lo: 9, hi: 10 }]);
    expect(u.contains(source, a.file, 1, 7)).toBe(true);
    expect(u.overlaps(source, a.file, 0, 1)).toBe(false);
    expect(u.overlaps(source, a.file, 7, 9)).toBe(false);
    expect(u.overlaps(source, a.file, 0, 2)).toBe(true);
    expect(u.contains(source, a.file, 6, 10)).toBe(false);
    expect(u.overlaps({}, a.file, 1, 2)).toBe(false);
    expect(u.overlaps(source, { ...a.file, key: "other" }, 1, 2)).toBe(false);
  });

  test("planning is open; sealing after navigation does not steal focus", () => {
    const h = harness(), a = series("a"), b = series("b"), j = h.jobs.create("a");
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(true);
    h.jobs.focusBrowse();
    j.seal(h.resolver, [{ file: a.file, lo: 0, hi: 10 }]);
    expect(h.jobs.foreground.kind).toBe("browse");
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(true);
    h.jobs.focusExport(j.id);
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(false);
  });

  test("old UI tokens cannot release a resumed job; actual completion can", async () => {
    const h = harness(), a = series("a"), j = focus(h, a, 0, 10);
    const old = h.jobs.focusExport(j.id)!;
    h.jobs.focusBrowse();
    const resumed = h.jobs.focusExport(j.id)!;
    h.jobs.retireFocus(old);
    expect(h.jobs.foreground).toEqual({ kind: "export", jobId: j.id, epoch: resumed.epoch });
    await j.run({ write: async () => {}, close: async () => {}, abort: async () => {} }, async (task, sink) => { task.sourcesVerified(); await sink.close(); });
    expect(h.jobs.foreground.kind).toBe("browse");
    expect(h.jobs.focusExport(j.id)).toBeUndefined();
  });

  test("only one job defines admission; A finishing cannot alter B", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const first = focus(h, a, 0, 10), second = focus(h, b, 0, 10);
    expect(h.jobs.allows(h.resolver, a.file, 0, 1)).toBe(false);
    const before = h.jobs.foreground;
    await expect(first.run({ write: async () => {}, close: async () => {}, abort: async () => {} }, async () => { throw new Error("late"); })).rejects.toThrow("late");
    first.cancel();
    expect(h.jobs.foreground).toBe(before);
    expect(second.terminal).toBe(false);
  });

  test("cancel before planning finishes prevents sealing and reads", () => {
    const h = harness(), a = series("a"), j = h.jobs.create("a");
    j.cancel();
    expect(() => j.seal(h.resolver, [{ file: a.file, lo: 0, hi: 10 }])).toThrow();
    expect(() => j.read(h.resolver, { file: a.file, lo: 0, hi: 1 }, async () => new Uint8Array())).toThrow();
    expect(h.jobs.foreground.kind).toBe("browse");
  });
});

describe("ordinary and WSI admission", () => {
  test("FrameStream's byte adapter inherits admission once and still serves cached reads", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const bytes = new LoaderBytes(h.loader, b);
    const job = focus(h, a, 0, 10);
    const reading = bytes.read(0, PT, { purpose: "header" });
    expect(h.calls.length).toBe(0);
    h.jobs.focusBrowse(); await turn();
    expect(h.calls.length).toBe(1);
    h.calls[0].finish(); await reading;
    h.jobs.focusExport(job.id);
    await bytes.read(0, PT, { purpose: "header" });
    expect(h.calls.length).toBe(1);
  });

  test("unrelated reads hold no slot, overlapping natural geometry stays intact, browse wakes both", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const job = focus(h, a, 5, 6);
    const other = h.loader.instance(b, 0);
    const reader = new SeriesReader(h.resolver as any, h.decryptor, b, { admission: h.jobs });
    const tile = reader.read(PT, 2 * PT);
    const own = h.loader.range(a, planInstances(a, 0, 5));
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].plan.firstRecord).toBe(0);
    expect(h.calls[0].plan.lastRecord).toBe(5);
    h.jobs.focusBrowse();
    await turn();
    expect(h.calls.length).toBe(3);
    expect(job.signal.aborted).toBe(false);
    h.calls.forEach((c) => c.finish());
    await Promise.all([other, own, tile]);
  });

  test("in-flight joins and cache hits are available under an unrelated gate", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const active = h.loader.ciphertext(b, 0);
    focus(h, a, 0, 10);
    const joined = h.loader.ciphertext(b, 0);
    expect(h.calls.length).toBe(1);
    h.calls[0].finish();
    await Promise.all([active, joined]);
    await h.loader.ciphertext(b, 0);
    expect(h.calls.length).toBe(1);
  });

  test("a denied adjacent span cannot enter an admitted merge", async () => {
    const h = harness(), a = series("a");
    const active = h.loader.ciphertext(a, 8, { priority: FetchPriority.Prefetch });
    const job = focus(h, a, 1, 2);
    const yes = h.loader.ciphertext(a, 1, { priority: FetchPriority.Prefetch });
    const no = h.loader.ciphertext(a, 2, { priority: FetchPriority.Prefetch });
    expect(h.calls.length).toBe(1);
    h.calls[0].finish(); await active; await turn();
    expect(h.calls.length).toBe(2);
    expect([h.calls[1].plan.firstRecord, h.calls[1].plan.lastRecord]).toEqual([1, 1]);
    h.calls[1].finish(); await yes;
    job.cancel(); await turn();
    expect(h.calls.length).toBe(3);
    h.calls[2].finish(); await no;
  });

  test("navigation cleanup preserves an export joined to a cached queued span", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const blocker = focus(h, b, 0, 10), navigation = new AbortController();
    const prefetch = h.loader.ciphertext(a, 2, { priority: FetchPriority.Prefetch, signal: navigation.signal }).catch((e) => e.name);
    const archive = h.loader.run(a, planInstances(a, 2), { durable: true });
    navigation.abort();
    h.loader.cancelQueued(() => true);
    expect(await prefetch).toBe("AbortError");
    blocker.cancel(); await turn();
    expect(h.calls.length).toBe(1);
    h.calls[0].finish(); await archive;
  });

  test("cancelled archive leaves shared browsing owner and complete records intact", async () => {
    const h = harness(), a = series("a"), cancel = new AbortController();
    const archive = h.loader.run(a, planInstances(a, 0, 2), { durable: true, signal: cancel.signal }).catch((e) => e.name);
    const browse = h.loader.instance(a, 1);
    cancel.abort();
    expect(await archive).toBe("AbortError");
    expect(h.calls[0].signal?.aborted).toBe(false);
    h.calls[0].finish(); await browse;
  });

  test("held WSI reader cancels without fetching and does not wake later", async () => {
    const h = harness(), a = series("a"), b = series("b"), ac = new AbortController();
    const job = focus(h, a, 0, 10);
    const reader = new SeriesReader(h.resolver as any, h.decryptor, b, { admission: h.jobs });
    const waiting = reader.read(0, PT, { signal: ac.signal }).catch((e) => e.name);
    ac.abort(); expect(await waiting).toBe("AbortError");
    job.cancel(); await turn();
    expect(reader.queued).toBe(0);
    expect(h.calls.length).toBe(0);
  });

  test("WSI cache and active joins bypass a gate; repeated gate changes do not lose a wakeup", async () => {
    const h = harness(), a = series("a"), b = series("b");
    const reader = new SeriesReader(h.resolver as any, h.decryptor, b, { admission: h.jobs });
    const first = reader.read(0, PT);
    const job = focus(h, a, 0, 10);
    const joined = reader.read(0, PT);
    h.calls[0].finish(); await Promise.all([first, joined]);
    await reader.read(0, PT);
    const held = reader.read(PT, 2 * PT);
    expect(h.calls.length).toBe(1);
    h.jobs.focusBrowse(); h.jobs.focusExport(job.id); h.jobs.focusBrowse();
    await turn(); expect(h.calls.length).toBe(2);
    h.calls[1].finish(); await held;
  });

  test("merged spans transfer durable ownership through a navigation cancellation", async () => {
    const h = harness(), a = series("a"), navigation = new AbortController();
    const active = h.loader.ciphertext(a, 8, { priority: FetchPriority.Prefetch });
    const first = h.loader.ciphertext(a, 1, { priority: FetchPriority.Prefetch, signal: navigation.signal }).catch((e) => e.name);
    const second = h.loader.ciphertext(a, 2, { priority: FetchPriority.Prefetch, signal: navigation.signal }).catch((e) => e.name);
    const keeper = h.loader.run(a, planInstances(a, 2), { durable: true });
    h.calls[0].finish(); await active; await turn();
    expect([h.calls[1].plan.firstRecord, h.calls[1].plan.lastRecord]).toEqual([1, 2]);
    navigation.abort(); h.loader.cancelQueued(() => true);
    expect(await first).toBe("AbortError"); expect(await second).toBe("AbortError");
    expect(h.calls[1].signal?.aborted).toBe(false);
    h.calls[1].finish(); await keeper;
  });

  test("short final record retains its actual ciphertext length and full authentication tag", async () => {
    const h = harness(), a = series("a", 2);
    a.instances[1].length = 7;
    a.file.plaintextLength = PT + 7;
    a.file.ciphertextLength = CT + 7 + 16;
    focus(h, a, 1, 2);
    const reading = h.loader.instance(a, 1);
    expect(h.calls[0].plan.rangeHeader).toBe(`bytes=${CT}-${CT + 22}`);
    h.calls[0].finish();
    expect((await reading).byteLength).toBe(7);
  });
});

describe("planned streaming export", () => {
  for (const failure of ["fetch", "authentication", "close"] as const) test(`${failure} failure is terminal, releases every pump and never succeeds`, async () => {
    const h = harness(), a = series("a", 1), b = series("b"), plan = planExport({ kind: "series", study: {} as any, series: a });
    const job = h.jobs.create("a.zip");
    let aborts = 0, finish!: () => void;
    const sink = { write: async () => {}, close: async () => { throw new Error("close"); }, abort: async () => { aborts++; } };
    const loader = { resolver: h.resolver, run: () => new Promise<Uint8Array[]>((resolve, reject) => {
      finish = () => failure === "close" ? resolve([new Uint8Array([1, 2, 3])]) : reject(new Error(failure));
    }) };
    const writing = job.run(sink, (task, owned) => writePlannedZip(plan, loader as any, owned, task)).catch((e) => e.message);
    await turn();
    const ordinary = h.loader.instance(b, 0);
    const reader = new SeriesReader(h.resolver as any, h.decryptor, b, { admission: h.jobs });
    const slide = reader.read(PT, 2 * PT);
    expect(h.calls.length).toBe(0);
    finish(); expect(await writing).toBe(failure); await turn();
    expect(job.phase).toBe("failed");
    expect(job.snapshot.cleanupComplete).toBe(true);
    expect(h.jobs.foreground.kind).toBe("browse");
    expect(h.calls.length).toBe(2);
    h.calls.forEach((c) => c.finish()); await Promise.all([ordinary, slide]);
    expect(aborts).toBe(1);
    job.cancel(); expect(job.phase).toBe("failed");
  });

  test("complete future scope is sealed, including objects outside the first series", () => {
    const h = harness(), a = series("a", 200), b = series("b", 2);
    const plan = planExport({ kind: "study", study: { series: [a, b] } as any });
    const job = h.jobs.create("all.zip");
    job.seal(h.resolver, plan.runs.map((r) => ({ file: r.series.file, lo: r.plan.firstRecord, hi: r.plan.lastRecord + 1 })));
    expect(plan.runs.length).toBe(3);
    expect(plan.total.files).toBe(202);
    expect(job.scope!.contains(h.resolver, b.file, 1, 2)).toBe(true);
    expect(job.scope!.contains(h.resolver, b.file, 1, 3)).toBe(false);
    a.instances.pop();
    expect(plan.total.files).toBe(202);
    expect(plan.runs[1].series.instances.length).toBe(200);
    expect(Object.isFrozen(plan.runs[0].plan)).toBe(true);
  });

  test("write failure releases gate before slow cleanup and aborts all read-ahead", async () => {
    const h = harness(), a = series("a", 400), b = series("b"), plan = planExport({ kind: "series", study: {} as any, series: a });
    const job = h.jobs.create("a.zip");
    const signals: AbortSignal[] = [];
    const loader = { resolver: h.resolver, run: async (_s: any, p: RangePlan, o: any) => {
      signals.push(o.signal);
      if (signals.length > 1) return new Promise<Uint8Array[]>((_resolve, reject) => o.signal.addEventListener("abort", () => reject(o.signal.reason), { once: true }));
      return Array.from({ length: p.lastInstance - p.firstInstance + 1 }, () => new Uint8Array(32));
    } };
    let finishAbort!: () => void, aborts = 0;
    const sink = { write: async () => { throw new Error("disk"); }, close: async () => {}, abort: () => { aborts++; return new Promise<void>((r) => finishAbort = r); } };
    const writing = job.run(sink, (task, owned) => writePlannedZip(plan, loader as any, owned, task)).catch((e) => e.message);
    await turn();
    expect(job.phase).toBe("failed");
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(true);
    expect(signals.length).toBe(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(aborts).toBe(1);
    expect(job.snapshot.cleanupComplete).toBe(false);
    finishAbort();
    expect(await writing).toBe("disk");
    expect(job.snapshot.cleanupComplete).toBe(true);
  });

  test("verified source barrier retains gate through sink close and execution completion", async () => {
    const h = harness(), a = series("a", 1), b = series("b"), plan = planExport({ kind: "series", study: {} as any, series: a });
    const job = h.jobs.create("a.zip");
    let finishClose!: () => void;
    const chunks: Uint8Array[] = [];
    const sink = { write: async (c: Uint8Array) => { chunks.push(c); }, close: () => new Promise<void>((r) => finishClose = r), abort: async () => {} };
    const loader = { resolver: h.resolver, run: async () => [new Uint8Array([1, 2, 3])] };
    const writing = job.run(sink, (task, owned) => writePlannedZip(plan, loader as any, owned, task));
    await turn();
    expect(job.phase).toBe("finalizing");
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(false);
    expect(chunks.some((c) => c.length === 3 && c[2] === 3)).toBe(true);
    finishClose(); await writing;
    expect(job.phase).toBe("completed");
    expect(h.jobs.allows(h.resolver, b.file, 0, 1)).toBe(true);
  });
});
