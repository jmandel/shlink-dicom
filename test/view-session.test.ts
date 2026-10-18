import { expect, test } from "bun:test";
import { LatestOperation, ViewSession } from "../web/view/view-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("new slices and reformats replace the same presentation without replacing the series", () => {
  const view = new ViewSession(), series = view.capture(), effects: string[] = [];
  const slice = view.beginPresentation();
  slice.commit(() => effects.push("slice progress"));
  const volume = view.beginPresentation();
  slice.commit(() => effects.push("old slice"));
  volume.commit(() => effects.push("volume"));
  const acquired = view.beginPresentation();
  volume.commit(() => effects.push("old volume error"));
  acquired.commit(() => effects.push("acquired"));
  expect(series.current()).toBe(true);
  expect(effects).toEqual(["slice progress", "volume", "acquired"]);
});

test("leaving a series invalidates its view and presentation, including captured header continuations", () => {
  const view = new ViewSession(), series = view.capture(), image = view.beginPresentation(), header = view.capturePresentation();
  view.reset();
  expect(series.current()).toBe(false); expect(image.current()).toBe(false); expect(header.current()).toBe(false);
  expect(view.capture().current()).toBe(true);
  expect(view.beginPresentation().current()).toBe(true);
});

test("obsolete data still finishes for the cache but cannot draw, report progress or overwrite an error", async () => {
  const view = new ViewSession(), operation = view.beginPresentation(), data = deferred<number>();
  const cache: number[] = [], display: number[] = [];
  const read = data.promise.then((n) => { cache.push(n); operation.commit(() => display.push(n)); });
  view.beginPresentation(); data.resolve(7); await read;
  expect(cache).toEqual([7]); expect(display).toEqual([]);
  expect(operation.commit(() => display.push(-1))).toBe(false);
});

test("a navigation A/B/A sequence never revives the first A", async () => {
  const navigation = new LatestOperation(), ready = deferred<void>(); const opened: string[] = [];
  const firstA = navigation.begin();
  const delayed = ready.promise.then(() => firstA.commit(() => opened.push("old A")));
  navigation.begin(); const secondA = navigation.begin();
  ready.resolve(); await delayed;
  secondA.commit(() => opened.push("new A"));
  expect(opened).toEqual(["new A"]);
});

test("replaced overview sequences finish active work but cannot start remaining thumbnails or prefetch", async () => {
  const renders = new LatestOperation(), old = renders.begin(), bytes = deferred<void>();
  const events: string[] = [];
  const first = old.start(() => { events.push("first"); return bytes.promise; });
  const next = Promise.resolve(first).then(() => old.start(async () => { events.push("obsolete next"); }));
  const done = next.then(() => old.commit(() => events.push("obsolete prefetch")));
  const current = renders.begin();
  bytes.resolve(); await done;
  await current.start(async () => { events.push("current"); });
  expect(events).toEqual(["first", "current"]);
});

test("an active sequence waits for each producer; aborting its consumer prevents the next step", async () => {
  const renders = new LatestOperation(), render = renders.begin(), ac = new AbortController(), first = deferred<void>();
  const work = render.withGuard(() => !ac.signal.aborted), events: string[] = [];
  const chain = Promise.resolve(work.start(() => first.promise)).then(() => work.start(async () => { events.push("next"); }));
  await Promise.resolve(); expect(events).toEqual([]);
  ac.abort(); first.resolve(); await chain;
  expect(events).toEqual([]);
  // The render's presentation permission and the consumer's cancellation remain distinct.
  expect(render.current()).toBe(true); expect(work.current()).toBe(false);
});

test("independent thumbnail targets do not invalidate each other; detached targets cannot draw", () => {
  const a = new LatestOperation(), b = new LatestOperation(); let attached = true;
  const firstA = a.begin(), firstB = b.begin(() => attached), secondA = a.begin();
  expect(firstA.current()).toBe(false); expect(firstB.current()).toBe(true); expect(secondA.current()).toBe(true);
  attached = false;
  expect(firstB.commit(() => { throw new Error("detached draw"); })).toBe(false);
});
