/// <reference lib="webworker" />
import { PROTOCOL, receivePort, type WireRequest } from "./transport";
declare const self: ServiceWorkerGlobalScope;
// Deliberately stateless: browsers may stop this worker between any two requests.
// The owning page's dedicated worker retains the resolver, immutable inventory and keys.
self.addEventListener("install", () => { void self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", event => {
  const root = new URL("dicomweb/", self.registration.scope), url = new URL(event.request.url);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
  const session = url.pathname.slice(root.pathname.length).split("/")[0];
  let complete!: () => void;
  event.waitUntil(new Promise<void>(res => { complete = res; }));
  event.respondWith((async () => {
    try {
      const client = await self.clients.get(event.clientId);
      if (!client || !/^[a-f0-9-]{36}$/.test(session)) return new Response("Open this link in its owning viewer tab", { status: 410 });
      const channel = new MessageChannel(), pending = receivePort(channel.port1, event.request.signal);
      const wire: WireRequest = { protocol: PROTOCOL, session, url: url.href, method: event.request.method, headers: [...event.request.headers] };
      client.postMessage(wire, [channel.port2]);
      pending.done.then(complete);
      return await pending.response;
    } catch (e) { complete(); return new Response((e as Error).message, { status: 502 }); }
    finally { /* Streaming keeps waitUntil alive until the port closes. */ }
  })().then(r => { if (r.status === 410) complete(); return r; }));
});
