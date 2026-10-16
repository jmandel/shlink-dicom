import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
// The JPEG 2000 encoder alone in headless Chromium: no parsing, no self-checks.
//
//   node codecs/shl-dicom-transcode-wasm/test/bench-encoder.mjs PKG_DIR RAW_DIR COLUMNS ROWS BITS SIGNED
//
// PKG_DIR: wasm-bindgen output of a `--features bench` build. RAW_DIR: one-component 16-bit
// little-endian frames named f0.rawl, f1.rawl, ... (for example from `shl-dicom-decode`).
import { readdirSync } from "node:fs";
const [pkg, rawDir, cols, rows, bits, signedArg] = process.argv.slice(2);
const names = readdirSync(rawDir).filter((n) => n.endsWith(".rawl")).sort();
const page = `<!doctype html><script type="module">
import init, { encode_only_j2k } from "/pkg/shl_dicom_transcode_wasm.js";
await init({ module_or_path: "/pkg/shl_dicom_transcode_wasm_bg.wasm" });
window.run = async () => {
  const frames = [];
  for (const n of NAMES) frames.push(new Uint8Array(await (await fetch("/raw/" + n)).arrayBuffer()));
  let best = Infinity, out = 0;
  for (let rep = 0; rep < 2; rep++) {
    const t0 = performance.now(); out = 0;
    for (const f of frames) out += encode_only_j2k(f, COLS, ROWS, BITS, SIGNED);
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, out, bytes: frames.reduce((a, f) => a + f.length, 0) };
};
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page
    .replace("NAMES", JSON.stringify(names)).replace("COLS", cols).replace("ROWS", rows).replace("BITS", bits).replace("SIGNED", String(signedArg === "1" || signedArg === "true")));
  if (req.url.startsWith("/pkg/")) return res.writeHead(200, { "content-type": req.url.endsWith(".js") ? "text/javascript" : "application/wasm" }).end(readFileSync(pkg + req.url.slice(4)));
  if (req.url.startsWith("/raw/")) return res.writeHead(200).end(readFileSync(rawDir + "/" + req.url.slice(5)));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, r));
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${server.address().port}/`);
await p.waitForFunction(() => window.ready);
const r = await p.evaluate(() => window.run());
console.log(`wasm encode only: ${(r.bytes / 1e6 / (r.ms / 1000)).toFixed(1)} MB/s, ${(r.out / 1e6).toFixed(2)} MB`);
await b.close(); server.close();
