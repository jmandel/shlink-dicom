// Static server for the browser runner. Cross-origin isolated (COOP/COEP), so
// performance.now() has 5 µs resolution in Chromium instead of 100 µs.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { binDir } from "./build.mjs";
import { BENCH, FORMATS } from "./corpus.mjs";

const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

export function serve() {
  const roots = { "/bench/": BENCH, "/corpus/": FORMATS, "/wasm/": binDir() };
  const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const prefix = Object.keys(roots).find((p) => url.startsWith(p));
    const file = prefix && normalize(join(roots[prefix], url.slice(prefix.length)));
    if (!file || !file.startsWith(roots[prefix]) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://localhost:${server.address().port}` })));
}
