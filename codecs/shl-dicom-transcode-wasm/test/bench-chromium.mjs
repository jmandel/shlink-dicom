// The wasm transcoder in headless Chromium: speed, sizes, and byte-identical output to the native
// build (determinism across builds).
//
//   node codecs/shl-dicom-transcode-wasm/test/bench-chromium.mjs PKG_DIR FILES_DIR NATIVE_HASHES_JSON [TS]
//
// PKG_DIR: wasm-bindgen --target web output. FILES_DIR: DICOM files (searched recursively).
// NATIVE_BENCH_JSON: {"relative/path": "sha256 of the native output" | "declined: ..."}, written by
// `cargo run --release -p shl-dicom-transcode --example hashes -- FILES_DIR [TS]`. TS defaults to
// JPEG Lossless SV1. Needs playwright-core
// (NODE_PATH pointing at a node_modules that has it) and /usr/bin/chromium.
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium } from "playwright-core";

const [pkg, dir, nativeJson, ts = "1.2.840.10008.1.2.4.70"] = process.argv.slice(2);
const native = JSON.parse(readFileSync(nativeJson, "utf8"));
const files = [];
(function walk(d) {
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dir, p));
  }
})(dir);

const page = `<!doctype html><script type="module">
import init, { transcode_part10 } from "/pkg/shl_dicom_transcode_wasm.js";
await init({ module_or_path: "/pkg/shl_dicom_transcode_wasm_bg.wasm" });
window.run = async (names, ts) => {
  const out = [];
  let ms = 0, pin = 0, pout = 0;
  for (const name of names) {
    const bytes = new Uint8Array(await (await fetch("/file/" + encodeURIComponent(name))).arrayBuffer());
    const t0 = performance.now();
    const r = transcode_part10(bytes, ts);
    const dt = performance.now() - t0;
    const b = r.bytes;
    let hash = null;
    if (b) {
      ms += dt; pin += r.pixelBytesIn; pout += r.pixelBytesOut;
      hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    }
    out.push({ name, hash, declined: r.declined ?? null });
    r.free();
  }
  return { out, ms, pin, pout };
};
window.ready = true;
</script>`;

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url);
  try {
    if (url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (url.startsWith("/pkg/")) {
      const f = url.slice(5);
      const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return res.writeHead(200, { "content-type": type }).end(readFileSync(join(pkg, f)));
    }
    if (url.startsWith("/file/")) return res.writeHead(200).end(readFileSync(join(dir, url.slice(6))));
  } catch {}
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
try {
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.error("[page error]", e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.waitForFunction(() => window.ready);
  const { out, ms, pin, pout } = await p.evaluate(([n, t]) => window.run(n, t), [files, ts]);
  let same = 0, differ = 0, encoded = 0;
  for (const r of out) {
    const want = native[r.name];
    const got = r.hash ?? `declined: ${r.declined}`;
    if (r.hash) encoded++;
    if (want === got) same++;
    else {
      differ++;
      console.log("DIFFERS", r.name, want, got);
    }
  }
  console.log(`${encoded} encoded of ${out.length}; pixel data ${(pin / 1e6).toFixed(1)} MB -> ${(pout / 1e6).toFixed(1)} MB (ratio ${(pin / pout).toFixed(2)}); ` +
    `wasm ${(ms / 1000).toFixed(2)} s, ${(pin / 1e6 / (ms / 1000)).toFixed(1)} MB/s; identical to native: ${same}, different: ${differ}`);
  process.exitCode = differ ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
