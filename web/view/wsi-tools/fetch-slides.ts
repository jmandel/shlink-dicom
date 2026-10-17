// Puts the whole-slide inputs listed in slides.json under SLIDES (default
// /media/barracuda/shlink-dicom-slides/dl): from the sample mirror first, then from IDC, each
// checked against its SHA-256 (deploy/lib/pinned-fetch.ts). A file no source has is reported and
// left out; the checks that use it skip it.
//   bun web/view/wsi-tools/fetch-slides.ts
import { readFileSync } from "node:fs";
import { fetchPinned } from "../../../deploy/lib/pinned-fetch";

const SLIDES = process.env.SLIDES ?? "/media/barracuda/shlink-dicom-slides/dl";
const list = JSON.parse(readFileSync(new URL("./slides.json", import.meta.url), "utf8"));
let got = 0;
const missing: string[] = [];
for (const f of list.files) {
  try {
    await fetchPinned({ url: f.url, sha256: f.sha256, name: f.name, mirror: list.mirror }, { keep: SLIDES });
    got++;
  } catch (e) {
    missing.push(`${f.name}: ${(e as Error).message}`);
  }
}
console.log(`${got} slide files in place; ${missing.length} missing (optional)`);
for (const m of missing) console.log(`  missing ${m}`);
