import { expect, test } from "bun:test";
import { ExportExecution, type RecordInterval } from "../web/core/export-execution";
import type { ByteSink } from "../web/core/zip";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sink(overrides: Partial<ByteSink> = {}) {
  const calls: string[] = [];
  const writer: ByteSink = {
    write: async () => { calls.push("write"); }, close: async () => { calls.push("close"); }, abort: async () => { calls.push("abort"); }, ...overrides,
  };
  return { calls, writer };
}
const source = {};
const range: RecordInterval = { file: { fileId: "test", key: "test", plaintextLength: 65520, ciphertextLength: 65536, recordCount: 1 }, lo: 0, hi: 1 };
function empty(task: ExportExecution) { task.seal(source, []); task.sourcesVerified(); }

test("success requires source verification and the writer close; snapshots cannot mutate the task", async () => {
  const close = deferred<void>();
  const { calls, writer } = sink({ close: () => close.promise });
  const job = new ExportExecution(1, "a");
  const original = job.snapshot;
  const writing = job.run(writer, async (task, out) => {
    task.seal(source, [range]);
    const bytes = await task.read(source, range, async () => new Uint8Array([7]), () => task.sourcesVerified());
    task.update({ files: 1, totalFiles: 1, bytes: 1, totalBytes: 1 });
    await out.write(bytes); await out.close();
  });
  await turn();
  expect(job.phase).toBe("finalizing");
  expect(job.snapshot.cleanupComplete).toBe(false);
  expect(original.phase).toBe("planning");
  expect(Object.isFrozen(job.snapshot)).toBe(true);
  expect(Object.isFrozen(job.snapshot.progress)).toBe(true);
  expect(() => { (job.snapshot as any).phase = "completed"; }).toThrow();
  close.resolve(); await writing;
  expect(job.phase).toBe("completed");
  expect(job.snapshot.cleanupComplete).toBe(true);
  job.cancel();
  expect(calls).toEqual(["write"]);
});

test("a later read-ahead failure stops a stalled earlier read and reports terminal before cleanup", async () => {
  const later = deferred<Uint8Array>(), abort = deferred<void>();
  const events: string[] = [];
  const job = new ExportExecution(1, "a", { changed: (kind) => { if (kind === "terminal") events.push("terminal"); }, event: () => {} });
  const { writer } = sink({ abort: () => { events.push("writer-abort"); return abort.promise; } });
  const writing = job.run(writer, async (task) => {
    task.seal(source, [range]);
    const first = task.read(source, range, (signal) => new Promise<Uint8Array>((_yes, no) => {
      signal.addEventListener("abort", () => { events.push("read-abort"); no(signal.reason); }, { once: true });
    }));
    void task.read(source, range, () => later.promise);
    await first;
  }).catch((e) => e.message);
  await turn(); later.reject(new Error("authentication")); await turn();
  expect(job.phase).toBe("failed");
  expect(events).toEqual(["terminal", "read-abort", "writer-abort"]);
  expect(job.snapshot.cleanupComplete).toBe(false);
  abort.resolve();
  expect(await writing).toBe("authentication");
  expect(job.snapshot.cleanupComplete).toBe(true);
});

test("cancellation while a picker is pending owns and aborts its eventual writer exactly once", async () => {
  const target = deferred<ByteSink | null>(), abort = deferred<void>(); let aborts = 0, writes = 0;
  const job = new ExportExecution(1, "a");
  const writing = job.run(target.promise, async () => { writes++; }).catch((e) => e.name);
  job.cancel(); job.cancel();
  expect(job.phase).toBe("cancelled");
  expect(job.snapshot.cleanupComplete).toBe(false);
  target.resolve(sink({ abort: () => { aborts++; return abort.promise; } }).writer);
  await turn();
  expect(aborts).toBe(1); expect(writes).toBe(0);
  expect(job.snapshot.cleanupComplete).toBe(false);
  abort.resolve();
  expect(await writing).toBe("AbortError");
  expect(job.snapshot.cleanupComplete).toBe(true);
});

test("picker cancellation and rejection finish through the same owner", async () => {
  const cancelled = new ExportExecution(1, "cancel"), failed = new ExportExecution(2, "fail");
  await expect(cancelled.run(Promise.resolve(null), async () => { throw new Error("must not run"); })).rejects.toThrow("export cancelled");
  await expect(failed.run(Promise.reject(new Error("picker")), async () => {})).rejects.toThrow("picker");
  expect(cancelled.phase).toBe("cancelled"); expect(failed.phase).toBe("failed");
  expect(cancelled.snapshot.cleanupComplete && failed.snapshot.cleanupComplete).toBe(true);
});

for (const stage of ["write", "close"] as const) test(`${stage} failure aborts once and cannot be turned into success`, async () => {
  const job = new ExportExecution(1, "a");
  const { writer, calls } = sink({ [stage]: async () => { throw new Error(stage); } });
  await expect(job.run(writer, async (task, out) => { empty(task); await out.write(new Uint8Array(1)); await out.close(); })).rejects.toThrow(stage);
  expect(job.phase).toBe("failed"); expect(job.snapshot.cleanupComplete).toBe(true);
  job.cancel();
  expect(calls.filter((c) => c === "abort").length).toBe(1);
});

test("catching a writer error in the formatter cannot hide failure or permit another write", async () => {
  const job = new ExportExecution(1, "a");
  let writes = 0;
  const { writer, calls } = sink({ write: async () => { writes++; throw new Error("disk full"); } });
  await expect(job.run(writer, async (task, out) => {
    empty(task);
    await out.write(new Uint8Array(1)).catch(() => {});
    expect(task.phase).toBe("failed");
    expect(task.signal.aborted).toBe(true);
    await expect(out.write(new Uint8Array(1))).rejects.toThrow("disk full");
    await out.close().catch(() => {});
  })).rejects.toThrow("disk full");
  expect(writes).toBe(1);
  expect(calls).toEqual(["abort"]);
  expect(job.snapshot.cleanupComplete).toBe(true);
});

test("source verification refuses pending reads and new reads after verification", async () => {
  const bytes = deferred<Uint8Array>(); const job = new ExportExecution(1, "a");
  const writing = job.run(sink().writer, async (task, out) => {
    task.seal(source, [range]);
    const read = task.read(source, range, () => bytes.promise);
    expect(() => task.sourcesVerified()).toThrow("unverified");
    await read; task.sourcesVerified();
    expect(() => task.read(source, range, async () => new Uint8Array())).toThrow("running");
    await out.close();
  });
  await turn(); bytes.resolve(new Uint8Array()); await writing;
  expect(job.phase).toBe("completed");
});

test("a source outside the immutable plan never starts", async () => {
  let reads = 0; const job = new ExportExecution(1, "a");
  await expect(job.run(sink().writer, async (task) => {
    task.seal(source, [range]);
    await task.read({}, range, async () => { reads++; return new Uint8Array(); });
  })).rejects.toThrow("outside");
  expect(reads).toBe(0); expect(job.phase).toBe("failed");
});

test("a synchronous source failure also cancels read-ahead and preserves the first error", async () => {
  const job = new ExportExecution(1, "a"); let aborted = false;
  await expect(job.run(sink().writer, async (task) => {
    task.seal(source, [range]);
    void task.read(source, range, (signal) => new Promise((_yes, no) => signal.addEventListener("abort", () => { aborted = true; no(signal.reason); })));
    await task.read(source, range, () => { throw new Error("start"); });
  })).rejects.toThrow("start");
  expect(aborted).toBe(true); expect(job.snapshot.cleanupComplete).toBe(true);
});

test("the execution rejects missing close, premature close and double close", async () => {
  for (const variant of ["missing", "premature", "double"]) {
    const job = new ExportExecution(1, variant); const { writer, calls } = sink();
    await expect(job.run(writer, async (task, out) => {
      task.seal(source, []);
      if (variant !== "premature") task.sourcesVerified();
      if (variant !== "missing") await out.close();
      if (variant === "double") await out.close();
    })).rejects.toThrow();
    expect(job.phase).toBe("failed");
    expect(calls.filter((c) => c === "abort").length).toBe(1);
  }
});

test("cancellation during close never completes; a second run cannot take the writer", async () => {
  const close = deferred<void>(); const job = new ExportExecution(1, "a");
  const { writer, calls } = sink({ close: () => close.promise });
  const writing = job.run(writer, async (task, out) => { empty(task); await out.close(); }).catch((e) => e.name);
  await turn();
  await expect(job.run(sink().writer, async () => {})).rejects.toThrow("already started");
  job.cancel(); close.resolve();
  expect(await writing).toBe("AbortError"); expect(job.phase).toBe("cancelled");
  expect(calls).toEqual(["abort"]);
});

test("an already aborted external signal prevents work and still closes ownership", async () => {
  const ac = new AbortController(); ac.abort(new Error("external"));
  const job = new ExportExecution(1, "a"); const { writer, calls } = sink();
  await expect(job.run(writer, async () => { throw new Error("must not run"); }, ac.signal)).rejects.toThrow("external");
  expect(job.phase).toBe("cancelled"); expect(job.snapshot.cleanupComplete).toBe(true);
  expect(calls).toEqual(["abort"]);
});
