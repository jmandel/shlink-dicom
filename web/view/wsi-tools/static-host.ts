// A static file host with single-range support and CORS, standing in for any static host
// (PROPOSAL.md Appendix C).   bun web/view/wsi-tools/static-host.ts [root] [port]
const root = process.argv[2] ?? "/media/barracuda/shlink-dicom-slides/host";
const port = Number(process.argv[3] ?? 3335);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length" };
Bun.serve({
  port,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes("..")) return new Response("bad path", { status: 400, headers: cors });
    const f = Bun.file(root + path);
    if (!(await f.exists())) return new Response("not found", { status: 404, headers: cors });
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (!m) return new Response(f, { headers: { ...cors, "Content-Type": "application/octet-stream" } });
    const a = Number(m[1]), b = Math.min(f.size - 1, m[2] ? Number(m[2]) : f.size - 1);
    if (a > b) return new Response(null, { status: 416, headers: { ...cors, "Content-Range": `bytes */${f.size}` } });
    return new Response(f.slice(a, b + 1), {
      status: 206,
      headers: { ...cors, "Content-Type": "application/octet-stream", "Content-Range": `bytes ${a}-${b}/${f.size}`, "Content-Length": String(b - a + 1) },
    });
  },
});
console.log(`static host on :${port} serving ${root}`);
