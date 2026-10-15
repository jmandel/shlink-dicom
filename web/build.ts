// Builds the site into dist/web:
//
//   dist/web/index.html            landing           (/)
//   dist/web/view/index.html       View              (/view#shlink:/…)
//   dist/web/how/index.html        How it works      (/how), plus how/data.json and the pages it links (web/how/bake.ts)
//   dist/web/share/                Share             (/share, /share/manage, /share/smart-callback)
//   dist/web/assets/               one bundle per entry point + shared chunks, decoder worker,
//                                  shl_dicom_decode.wasm, shl_dicom_wasm_bg.wasm (Share: offset tables), CSS
//
// Pages reference assets relatively, so the static parts can be served from any path.
// Run: bun web/build.ts   (package.json: build:web)
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}dist/web`;
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
  entrypoints: ["viewer-kit/src/decoder-worker.ts"],
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
cpSync(offsetWasm, `${assets}/shl_dicom_wasm_bg.wasm`);
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
// How it works: codec coverage data, the rendered spec and reference code, the benchmark report.
const { bakeHow } = await import("./how/bake.ts");
await bakeHow(root, out);

const sizes = await $`cd ${out} && find . -type f \( -name '*.js' -o -name '*.wasm' -o -name '*.html' -o -name '*.css' \) -not -name '*.map' -printf '%s\t%p\n' | sort -k2`.text();
console.log(sizes);
