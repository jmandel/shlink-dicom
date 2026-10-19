import { PROTOCOL, servePort } from "./transport";
export interface StudySummary { uid: string; description: string; modalities: string[]; series: { uid: string; description: string; modality: string; instances: number }[] }
export interface DicomwebOptions { passcode?: string; signal?: AbortSignal }
const sessions = new Map<string, Worker>();
function dispatch(event: MessageEvent) {
  if (event.data?.protocol !== PROTOCOL || !event.ports[0]) return;
  const worker = sessions.get(event.data.session);
  if (worker) worker.postMessage(event.data, [event.ports[0]]);
  else void servePort(event.ports[0], event.data, async () => new Response("This session is not open in this viewer", { status: 410 }));
}
if (typeof navigator !== "undefined") navigator.serviceWorker?.addEventListener("message", dispatch);

/** Mount one SHLink as same-origin, read-only DICOMweb. Keep the returned session alive
 * while its viewer is open, then dispose it. Keys never appear in the DICOMweb URL. */
export async function openDicomweb(link: string, options: DicomwebOptions = {}) {
  if (!navigator.serviceWorker) throw new Error("DICOMweb needs HTTPS or localhost and Service Worker support");
  const base = new URL("./", import.meta.url);
  if (base.origin !== location.origin || !location.pathname.startsWith(base.pathname)) throw new Error("Serve the adapter next to the viewer, within its Service Worker scope");
  options.signal?.throwIfAborted();
  const registration = await navigator.serviceWorker.register(new URL("shlink-dicomweb-sw.js", base), { type: "module", scope: base.pathname, updateViaCache: "none" });
  if (!registration.active || navigator.serviceWorker.controller?.scriptURL !== new URL("shlink-dicomweb-sw.js", base).href) {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => { clean(); rej(new Error("Service Worker activation timed out")); }, 20_000);
      const check = () => { if (navigator.serviceWorker.controller?.scriptURL === new URL("shlink-dicomweb-sw.js", base).href) { clean(); res(); } };
      const clean = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", check); };
      navigator.serviceWorker.addEventListener("controllerchange", check); check();
    });
  }
  options.signal?.throwIfAborted();
  const id = crypto.randomUUID(), root = new URL(`dicomweb/${id}/`, base).href;
  const worker = new Worker(new URL("dicomweb-session-worker.js", base), { type: "module", name: "SHLink DICOMweb session" });
  sessions.set(id, worker);
  let closed = false;
  const frames = new Set<HTMLIFrameElement>();
  const forward = (event: MessageEvent) => {
    if (event.data?.protocol !== PROTOCOL || !event.ports[0]) return;
    if (event.data.session !== id || closed) return;
    dispatch(event);
  };
  const fromFrame = (event: MessageEvent) => {
    if (event.origin === location.origin && [...frames].some(f => f.contentWindow === event.source)) forward(event);
  };
  window.addEventListener("message", fromFrame);
  const dispose = () => {
    if (closed) return; closed = true;
    sessions.delete(id); window.removeEventListener("message", fromFrame);
    options.signal?.removeEventListener("abort", dispose); worker.postMessage({ type: "close" }); worker.terminate(); frames.clear();
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  try {
    const studies = await new Promise<StudySummary[]>((res, rej) => {
      const timer = setTimeout(() => { clean(); rej(new Error("Opening the link timed out")); }, 120_000);
      const cancel = () => { clean(); rej(new DOMException("Opening cancelled", "AbortError")); };
      const clean = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); worker.onmessage = null; worker.onerror = null; };
      options.signal?.addEventListener("abort", cancel, { once: true });
      worker.onerror = e => { clean(); rej(new Error(e.message)); };
      worker.onmessage = ({ data }) => {
        if (data.type === "opened") { clean(); res(data.studies); }
        else if (data.type === "error") { clean(); rej(new Error(data.message)); }
      };
      worker.postMessage({ type: "open", link, passcode: options.passcode, session: id, root });
    });
    return { id, root, studies, dispose, connectFrame(frame: HTMLIFrameElement) { frames.add(frame); return () => frames.delete(frame); } };
  } catch (e) { dispose(); throw e; }
}
