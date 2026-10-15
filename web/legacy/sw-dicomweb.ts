/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/dicomweb/")) {
    return;
  }
  event.respondWith(handleDicomwebRequest(url));
});

async function handleDicomwebRequest(url: URL): Promise<Response> {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clients.length === 0) {
    return new Response(JSON.stringify({ error: "No active SHL viewer client" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const client = clients[0];
  const channel = new MessageChannel();

  const replyPromise = new Promise<{
    status: number;
    contentType: string;
    body: ArrayBuffer | string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Service Worker DICOMweb bridge timeout")), 15000);
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer);
      resolve(ev.data);
    };
  });

  client.postMessage(
    {
      type: "SHL_DICOMWEB_REQUEST",
      path: url.pathname,
    },
    [channel.port2],
  );

  try {
    const reply = await replyPromise;
    return new Response(reply.body, {
      status: reply.status,
      headers: {
        "Content-Type": reply.contentType,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
