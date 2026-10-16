// Builds the site into dist/web:
//
//   dist/web/index.html            landing           (/)
//   dist/web/view/index.html       View              (/view#shlink:/…)
//   dist/web/how/index.html        How it works      (/how), plus how/data.json and the pages it links (web/how/bake.ts)
//   dist/web/share/                Share             (/share, /share/manage, /share/smart-callback)
//   dist/web/assets/               one bundle per entry point + shared chunks, decoder worker,
//                                  shl_dicom_decode.wasm, shl_dicom_decode_jxl.wasm (loaded only for JPEG XL), shl_dicom_wasm_bg.wasm (Share: offset tables), CSS
//
// Pages reference assets relatively, so the static parts can be served from any path.
// Run: bun web/build.ts   (package.json: build:web)
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
// Built into a private folder, then swapped into place, so a server reading dist/web
// never sees a half-built site (several builds can run at once).
const site = `${root}dist/web`;
const out = `${site}.build-${process.pid}`;
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
const assets = `${out}/assets`;
process.chdir(root);

const decodeWasm = "viewer-kit/dist/shl_dicom_decode.wasm";
if (!existsSync(decodeWasm)) {
  console.log("viewer-kit/dist missing: building viewer-kit");
  await $`node viewer-kit/scripts/build.mjs`;
}
const offsetWasm = "crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm";
if (!existsSync(offsetWasm)) {
  throw new Error(`${offsetWasm} missing: cargo build --release --target wasm32-unknown-unknown -p shl-dicom-wasm, then wasm-bindgen --target web (see deploy/bootstrap-shlink-dicom.sh)`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(assets, { recursive: true });

const minify = process.env.MINIFY !== "0";

// Entry points with code splitting: landing, view (and later how/share) share web/core chunks.
const r = await Bun.build({
  entrypoints: ["web/landing/landing.ts", "web/view/view.ts", "web/how/how.ts", "web/share/share.ts", "web/share/manage.ts"],
  outdir: assets,
  target: "browser",
  format: "esm",
  splitting: true,
  minify,
  sourcemap: "linked",
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}

// Decoder worker: its own file (Workers need a URL).
const w = await Bun.build({
  entrypoints: ["viewer-kit/src/decoder-worker.ts", "web/core/video-mpeg2-worker.ts", "web/share/lib/compress-worker.ts"],
  outdir: assets,
  target: "browser",
  format: "esm",
  minify,
  naming: "[name].[ext]",
});
if (!w.success) {
  for (const l of w.logs) console.error(l);
  process.exit(1);
}

cpSync(decodeWasm, `${assets}/shl_dicom_decode.wasm`);
cpSync("viewer-kit/dist/shl_dicom_decode_jxl.wasm", `${assets}/shl_dicom_decode_jxl.wasm`);
// pdf.js, loaded on demand by web/view/pdf-view.ts (reports and encapsulated PDFs).
mkdirSync(`${assets}/pdfjs`, { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) cpSync(`node_modules/pdfjs-dist/build/${f}`, `${assets}/pdfjs/${f}`);
cpSync(offsetWasm, `${assets}/shl_dicom_wasm_bg.wasm`);
// The Share page's lossless encoder (codecs/shl-dicom-transcode-wasm), loaded by its compress worker.
const transcodePkg = "codecs/shl-dicom-transcode-wasm/pkg";
if (!existsSync(`${transcodePkg}/shl_dicom_transcode_wasm_bg.wasm`)) {
  throw new Error(`${transcodePkg} missing: cargo build --release --target wasm32-unknown-unknown -p shl-dicom-transcode-wasm in codecs/, then wasm-bindgen --target web (see deploy/bootstrap-shlink-dicom.sh)`);
}
for (const f of ["shl_dicom_transcode_wasm.js", "shl_dicom_transcode_wasm_bg.wasm"]) cpSync(`${transcodePkg}/${f}`, `${assets}/${f}`);
// MPEG-2 video decoder (FFmpeg, LGPL-2.1+; codecs/mpeg2-wasm), loaded only for MPEG-2 video, and
// the exact FFmpeg source it was built from, which the LGPL requires us to offer alongside it.
for (const f of ["mpeg2dec.js", "mpeg2dec.wasm"]) cpSync(`codecs/mpeg2-wasm/dist/${f}`, `${assets}/${f}`);
cpSync("codecs/mpeg2-wasm/dist/COPYING.LGPLv2.1", `${assets}/ffmpeg-COPYING.LGPLv2.1.txt`);
mkdirSync(`${assets}/mpeg2dec-source`, { recursive: true });
for (const f of ["mpeg2dec.c", "build.sh", "ffmpeg-source.json", "README.md"]) cpSync(`codecs/mpeg2-wasm/${f}`, `${assets}/mpeg2dec-source/${f}`);
// The source tarball is not committed: fetched from ffmpeg.org when missing, and checked.
const ffmpeg = JSON.parse(readFileSync("codecs/mpeg2-wasm/ffmpeg-source.json", "utf8")) as { version: string; url: string; sha256: string };
const ffmpegName = `ffmpeg-${ffmpeg.version}.tar.xz`;
const ffmpegSource = `codecs/mpeg2-wasm/dist/${ffmpegName}`;
if (!existsSync(ffmpegSource)) {
  console.log(`fetching ${ffmpeg.url}`);
  const r = await fetch(ffmpeg.url);
  if (!r.ok) throw new Error(`${ffmpeg.url}: HTTP ${r.status}`);
  await Bun.write(`${ffmpegSource}.part`, await r.arrayBuffer());
  renameSync(`${ffmpegSource}.part`, ffmpegSource);
}
const ffmpegHash = new Bun.CryptoHasher("sha256").update(readFileSync(ffmpegSource)).digest("hex");
if (ffmpegHash !== ffmpeg.sha256) {
  rmSync(ffmpegSource);
  throw new Error(`${ffmpegName}: SHA-256 ${ffmpegHash}, expected ${ffmpeg.sha256}`);
}
cpSync(ffmpegSource, `${assets}/${ffmpegName}`);
cpSync("web/shared/base.css", `${assets}/base.css`);
cpSync("web/view/view.css", `${assets}/view.css`);
cpSync("web/landing/landing.css", `${assets}/landing.css`);
cpSync("web/how/how.css", `${assets}/how.css`);
cpSync("web/share/share.css", `${assets}/share.css`);

cpSync("web/landing/index.html", `${out}/index.html`);
// Site configuration (see web/core/config.ts). Empty: the API is on the same origin as the pages.
// A static deployment writes {"apiBase": "https://server.example"} here.
await Bun.write(`${out}/config.json`, "{}\n");
for (const p of ["view", "how", "share", "share/manage"]) {
  mkdirSync(`${out}/${p}`, { recursive: true });
  cpSync(`web/${p}/index.html`, `${out}/${p}/index.html`);
}
// SMART App Launch redirect target for Share (/share/smart-callback/): the Share page one level down.
mkdirSync(`${out}/share/smart-callback`, { recursive: true });
await Bun.write(
  `${out}/share/smart-callback/index.html`,
  (await Bun.file("web/share/index.html").text())
    .replaceAll('"../assets/', '"../../assets/')
    .replaceAll('href="../"', 'href="../../"')
    .replaceAll('href="manage"', 'href="../manage"'),
);
// How it works: its worker, the receiver file, and the images and C decoders it uses.
const { bakeHow } = await import("./how/bake.ts");
await bakeHow(root, out);

const old = `${site}.old-${process.pid}`;
if (existsSync(site)) renameSync(site, old);
renameSync(out, site);
rmSync(old, { recursive: true, force: true });

const sizes = await $`cd ${site} && find . -type f \( -name '*.js' -o -name '*.wasm' -o -name '*.html' -o -name '*.css' \) -not -name '*.map' -printf '%s\t%p\n' | sort -k2`.text();
console.log(sizes);
