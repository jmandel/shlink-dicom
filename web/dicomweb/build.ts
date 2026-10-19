// Pinned, standalone demo assets. No OHIF source build or runtime CDN dependency.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
export const OHIF_VERSION = "3.13.13";
const OHIF_INTEGRITY = "qqrHXYSVnLYy1qrJGVAkLvZEFnV39qUv21arpNTbAcdaxMIUIctf9bN6gad2QKlZuamPLvPb8RSCmjqn92T23g==";
export async function buildDicomweb(root: string, out: string, minify = true) {
  const dest = `${out}/demos`; mkdirSync(dest, { recursive: true });
  for (const entry of ["shlink-dicomweb", "shlink-dicomweb-sw", "dicomweb-session-worker"]) {
    const r = await Bun.build({ entrypoints: [`${root}/web/dicomweb/${entry}.ts`], outdir: dest, target: "browser", format: "esm", minify, splitting: false, naming: "[name].[ext]" });
    if (!r.success) throw new AggregateError(r.logs, `Building ${entry}`);
  }
  const r = await Bun.build({ entrypoints: [`${root}/web/dicomweb/demo.ts`, `${root}/node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js`], outdir: dest, target: "browser", format: "esm", minify, splitting: true, naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" } });
  if (!r.success) throw new AggregateError(r.logs, "Building Cornerstone demo");
  cpSync(`${root}/crates/shl-dicom-reader/pkg/shl_dicom_reader_bg.wasm`, `${dest}/shl_dicom_reader_bg.wasm`);
  for (const [pkg, file] of [["codec-charls", "charlswasm_decode.wasm"], ["codec-libjpeg-turbo-8bit", "libjpegturbowasm_decode.wasm"], ["codec-openjpeg", "openjpegwasm_decode.wasm"], ["codec-openjph", "openjphjs.wasm"], ["codec-libjxl", "jpegxlwasm_decode.wasm"]]) {
    cpSync(`${root}/node_modules/@cornerstonejs/${pkg}/dist/${file}`, `${dest}/${file}`);
  }
  cpSync(`${root}/web/dicomweb/demo.css`, `${dest}/demo.css`);
  const notices = ["Cornerstone3D 5.13.1\n" + readFileSync(`${root}/web/dicomweb/Cornerstone3D-LICENSE.txt`, "utf8")];
  // Keep the license notices distributed with the bundled runtime and its dependencies.
  const licenses = new Bun.Glob("**/{LICENSE,LICENSE.*,LICENCE,LICENCE.*,License,License.*,license,license.*,COPYING,COPYING.*,NOTICE,NOTICE.*,Copyright.txt}");
  for (const file of [...licenses.scanSync({ cwd: `${root}/node_modules`, onlyFiles: true })].sort()) {
    if (/\.(js|map|ts)$/.test(file)) continue;
    notices.push(`${file}\n${readFileSync(`${root}/node_modules/${file}`, "utf8")}`);
  }
  await Bun.write(`${dest}/THIRD_PARTY_NOTICES.txt`, notices.join("\n\n----------------------------------------\n\n"));
  const template = readFileSync(`${root}/web/dicomweb/demo.html`, "utf8");
  for (const [kind, name] of [["cornerstone", "Cornerstone3D"], ["ohif", "OHIF"]]) {
    mkdirSync(`${dest}/${kind}`, { recursive: true });
    await Bun.write(`${dest}/${kind}/index.html`, template.replaceAll("__KIND__", kind).replaceAll("__NAME__", name).replaceAll("__TITLE__", `${name} · SMART Health Link demo`).replaceAll("__SERIES_HIDDEN__", kind === "ohif" ? "hidden" : ""));
  }
  const cache = `${root}/dist/vendor/ohif-${OHIF_VERSION}`, archive = `${cache}.tgz`;
  mkdirSync(`${root}/dist/vendor`, { recursive: true });
  if (!existsSync(archive)) {
    const url = `https://registry.npmjs.org/@ohif/app/-/app-${OHIF_VERSION}.tgz`;
    console.log(`Fetching pinned OHIF ${OHIF_VERSION}`);
    const response = await fetch(url); if (!response.ok) throw new Error(`OHIF download: ${response.status}`);
    await Bun.write(archive, await response.arrayBuffer());
  }
  const actual = new Bun.CryptoHasher("sha512").update(readFileSync(archive)).digest("base64");
  if (actual !== OHIF_INTEGRITY) { rmSync(archive); throw new Error("OHIF archive integrity mismatch"); }
  if (!existsSync(`${cache}/package/dist/index.html`)) {
    mkdirSync(cache, { recursive: true }); await $`tar -xzf ${archive} -C ${cache} package/dist package/LICENSE`.quiet();
  }
  const vendor = `${dest}/ohif-viewer`; cpSync(`${cache}/package/dist`, vendor, { recursive: true });
  cpSync(`${cache}/package/LICENSE`, `${vendor}/LICENSE`);
  const bundle = readdirSync(vendor).find(f => /^app\.bundle\..+\.js$/.test(f))!;
  const js = readFileSync(`${vendor}/${bundle}`, "utf8"), publicPath = '__webpack_require__.p = "/";';
  if (js.split(publicPath).length !== 2) throw new Error("OHIF public-path patch no longer matches its pinned release");
  // StudyItem's uncontrolled Radix state diverges when late display sets expand a
  // study programmatically after the user closes it. Share the parent's state
  // with the chevron/content; preserve OHIF's thumbnail and input handlers.
  const studyExpansion = "defaultValue: isActive ? 'study-item' : undefined";
  if (js.split(studyExpansion).length !== 2) throw new Error("OHIF study-expansion patch no longer matches its pinned release");
  await Bun.write(`${vendor}/${bundle}`, js.replace(publicPath, "__webpack_require__.p = window.PUBLIC_URL;").replace(studyExpansion, "value: isExpanded ? 'study-item' : ''"));
  let workerPatches = 0;
  for (const file of readdirSync(vendor)) {
    if (file === bundle) continue;
    if (file.endsWith(".js")) {
      const src = readFileSync(`${vendor}/${file}`, "utf8");
      if (src.includes(publicPath)) {
        workerPatches++; await Bun.write(`${vendor}/${file}`, src.replaceAll(publicPath, '__webpack_require__.p = new URL("./", self.location.href).href;'));
      }
    } else if (file.endsWith(".css")) {
      await Bun.write(`${vendor}/${file}`, readFileSync(`${vendor}/${file}`, "utf8").replaceAll("url(/", "url(./"));
    }
  }
  if (workerPatches !== 7) throw new Error("OHIF worker public-path patches no longer match the pinned release");
  cpSync(`${root}/web/dicomweb/ohif-config.js`, `${vendor}/app-config.js`);
  const original = readFileSync(`${vendor}/index.html`, "utf8").replace(/<script[^>]+src="\/init-service-worker\.js"[^>]*><\/script>/, "");
  for (const path of ["", "viewer/"]) {
    const relative = path ? "../" : "./";
    const html = original.replaceAll('window.PUBLIC_URL="/"', `window.PUBLIC_URL=new URL(${JSON.stringify(relative)},location.href).pathname`).replace(/(src|href|content)="\/(?!\/)/g, `$1="${relative}`);
    mkdirSync(`${vendor}/${path}`, { recursive: true }); await Bun.write(`${vendor}/${path}index.html`, html);
  }
  await Bun.write(`${dest}/versions.json`, JSON.stringify({ adapter: 1, cornerstone: "5.13.1", ohif: OHIF_VERSION }, null, 2));
}
if (import.meta.main) await buildDicomweb(resolve(import.meta.dir, "../.."), resolve(process.argv[2] ?? "dist/web"), process.env.MINIFY !== "0");
