// A static server that behaves like GitHub Pages for this site's checks: files under a path prefix,
// single byte ranges answered 206, Access-Control-Allow-Origin *, OPTIONS answered 405 (as Pages
// does; spec/README.md Appendix C), "dir" served as "dir/index.html" after a redirect to "dir/".
//
//   bun pages/checks/serve.ts <site dir> [--port 8787] [--prefix /shlink-dicom/]
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) throw new Error("usage: bun pages/checks/serve.ts <site dir> [--port N] [--prefix /p/]");
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = Number(opt("--port", "8787"));
const prefix = opt("--prefix", "/shlink-dicom/");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.method === "OPTIONS") return new Response("", { status: 405, headers: cors });
    if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404, headers: cors });
    let rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)));
    if (rel.startsWith("..")) return new Response("not found", { status: 404, headers: cors });
    let path = join(dir, rel);
    if (existsSync(path) && statSync(path).isDirectory()) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.pathname}/${url.search}`, 301);
      path = join(path, "index.html");
    }
    if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404, headers: cors });
    const file = Bun.file(path);
    const size = file.size;
    const headers: Record<string, string> = { ...cors, "Content-Type": types[extname(path)] ?? "application/octet-stream", "Accept-Ranges": "bytes" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (range) {
      let a = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
      let b = range[1] === "" || range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2]));
      if (a < 0) a = 0;
      if (a > b || a >= size) return new Response("", { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      return new Response(file.slice(a, b + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${a}-${b}/${size}` } });
    }
    return new Response(file, { headers });
  },
});
console.log(`serving ${dir} at http://localhost:${server.port}${prefix}`);
