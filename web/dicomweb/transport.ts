// A pull-based MessagePort transport. Only one response chunk is in flight; cancel closes
// the upstream reader and aborts the request. No streams need to be transferable.
export const PROTOCOL = "shlink-dicomweb-v1";
export type WireRequest = { protocol: typeof PROTOCOL; session: string; url: string; method: string; headers: [string, string][] };
const TIMEOUT = 120_000;

export async function servePort(port: MessagePort, request: WireRequest, handle: (r: Request) => Promise<Response>) {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, busy = false, closed = false;
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => close(), TIMEOUT); };
  const close = () => {
    if (closed) return; closed = true; clearTimeout(timer); abort.abort();
    void reader?.cancel().catch(() => {}); port.close();
  };
  port.onmessage = async ({ data }) => {
    if (data.type === "cancel") { close(); return; }
    if (data.type !== "pull" || busy || closed) return;
    busy = true; touch();
    try {
      const result = reader ? await reader.read() : { done: true as const, value: undefined };
      if (closed) return;
      if (result.done) { port.postMessage({ type: "end" }); close(); }
      else {
        // The loader may retain the source buffer in its cache; transfer an owned copy.
        const bytes = result.value.slice();
        port.postMessage({ type: "chunk", bytes }, [bytes.buffer]);
      }
    } catch (e) { if (!closed) port.postMessage({ type: "error", message: (e as Error).message }); close(); }
    finally { busy = false; }
  };
  touch();
  try {
    const response = await handle(new Request(request.url, { method: request.method, headers: request.headers, signal: abort.signal }));
    if (closed) { await response.body?.cancel(); return; }
    reader = response.body?.getReader();
    port.postMessage({ type: "headers", status: response.status, headers: [...response.headers] });
  } catch (e) { if (!closed) port.postMessage({ type: "error", message: (e as Error).message }); close(); }
}

export function receivePort(port: MessagePort, signal?: AbortSignal): { response: Promise<Response>; done: Promise<void> } {
  let resolve!: (r: Response) => void, reject!: (e: Error) => void, finish!: () => void;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined, closed = false;
  let pulled: (() => void) | undefined, timer: ReturnType<typeof setTimeout>;
  const response = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
  const done = new Promise<void>(res => { finish = res; });
  const stop = (error?: Error) => {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    if (error) { reject(error); controller?.error(error); } else controller?.close();
    pulled?.(); port.close(); finish();
  };
  const cancel = () => { port.postMessage({ type: "cancel" }); stop(new DOMException("DICOMweb request cancelled", "AbortError")); };
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { port.postMessage({ type: "cancel" }); stop(new Error("DICOMweb request timed out")); }, TIMEOUT); };
  port.onmessage = ({ data }) => {
    if (closed) return;
    touch();
    if (data.type === "headers") {
      const body = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        pull() { return new Promise<void>(res => { pulled = res; port.postMessage({ type: "pull" }); }); },
        cancel() { controller = undefined; cancel(); },
      }, { highWaterMark: 0 });
      resolve(new Response(body, { status: data.status, headers: data.headers }));
    } else if (data.type === "chunk") { controller?.enqueue(data.bytes); pulled?.(); pulled = undefined; }
    else if (data.type === "end") stop();
    else if (data.type === "error") stop(new Error(data.message));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  touch(); if (signal?.aborted) cancel();
  return { response, done };
}
