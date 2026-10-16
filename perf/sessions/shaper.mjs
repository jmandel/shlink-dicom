// TLS HTTP/2 front with a shaped link, like a real connection: each request waits one round trip
// (concurrently, as on a multiplexed connection), and response and request bodies share one
// downlink and one uplink, served round-robin in 16 KiB slices.
//   node shaper.mjs <frontPort>=<backPort>:<rttMs>:<downBytesPerS>:<upBytesPerS> ...
import http2 from "node:http2";
import http from "node:http";
import { readFileSync } from "node:fs";
import { Transform } from "node:stream";

const TLS = process.env.SHAPER_TLS ?? "/media/barracuda/e2e/tls";
const key = readFileSync(`${TLS}/key.pem`), cert = readFileSync(`${TLS}/cert.pem`);
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings", "te", "host"]);
const SLICE = 16384;

/** A link of `rate` bytes/s shared round-robin by the streams sending on it. */
class Link {
  constructor(rate) {
    this.rate = rate;
    // Slices of about 4 ms of the link (timers have about 1 ms grain).
    this.slice = Math.max(SLICE, Math.round(rate * 0.004));
    this.waiting = [];
    this.busyUntil = 0;
    this.timer = null;
  }
  /** Resolves when `n` bytes may go. */
  send(n) {
    if (!this.rate) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting.push({ n, resolve });
      this.kick();
    });
  }
  kick() {
    if (this.timer || !this.waiting.length) return;
    const now = performance.now();
    const w = this.waiting.shift();
    const start = Math.max(now, this.busyUntil);
    this.busyUntil = start + (w.n / this.rate) * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      w.resolve();
      this.kick();
    }, Math.max(0, this.busyUntil - now));
  }
}

const shaped = (link) =>
  new Transform({
    transform(chunk, _enc, cb) {
      (async () => {
        for (let i = 0; i < chunk.length; i += link.slice) {
          const part = chunk.subarray(i, i + link.slice);
          await link.send(part.length);
          this.push(part);
        }
      })().then(() => cb(), cb);
    },
  });

for (const spec of process.argv.slice(2)) {
  const [front, rest] = spec.split("=");
  const [back, rtt, down, up] = rest.split(":").map(Number);
  const dl = new Link(down), ul = new Link(up);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const server = http2.createSecureServer({ key, cert, allowHTTP1: true, settings: { initialWindowSize: 1 << 24 } }, (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(":") && !HOP.has(k)) headers[k] = v;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = req.headers[":authority"] ?? req.headers.host;
    headers.host = `127.0.0.1:${back}`;
    let closed = false;
    res.on("close", () => (closed = true));
    // Half a round trip on the way up, half on the way back.
    setTimeout(() => {
      if (closed) return;
      const upstream = http.request({ host: "127.0.0.1", port: back, method: req.method, path: req.url, headers, agent }, (ur) => {
        setTimeout(() => {
          if (closed) return ur.destroy();
          const h = {};
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) h[k] = v;
          res.writeHead(ur.statusCode, h);
          ur.pipe(shaped(dl)).pipe(res);
        }, rtt / 2);
      });
      upstream.on("error", (e) => { try { res.writeHead(502); res.end(String(e)); } catch {} });
      res.on("close", () => upstream.destroy());
      req.pipe(shaped(ul)).pipe(upstream);
    }, rtt / 2);
  });
  server.listen(Number(front), "127.0.0.1", () => console.error(`shaped https://127.0.0.1:${front} -> :${back} rtt ${rtt} ms, down ${down} B/s, up ${up} B/s`));
}
