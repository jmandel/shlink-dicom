// Compares web/core/icc.ts with lcms2 (through ImageMagick) on a colour cube.
//   bun web/view/wsi-tools/icc-check.ts <profile.icc> <srgb.icc>
// Prints max and mean |difference| per sample, and the 99th percentile.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { iccToSrgb } from "../../core/icc";

const [profile, srgb] = process.argv.slice(2);
const N = 32, W = N * N, H = N; // every (r, g, b) on a 32-step grid
const px = new Uint8Array(W * H * 3);
for (let r = 0; r < N; r++) for (let g = 0; g < N; g++) for (let b = 0; b < N; b++) {
  const o = ((b * W) + r * N + g) * 3;
  px[o] = Math.round((r * 255) / (N - 1)); px[o + 1] = Math.round((g * 255) / (N - 1)); px[o + 2] = Math.round((b * 255) / (N - 1));
}
const dir = "/media/barracuda/shlink-dicom-slides/work";
writeFileSync(`${dir}/cube.ppm`, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), Buffer.from(px)]));
execFileSync("magick", [`${dir}/cube.ppm`, "-profile", profile, "-profile", srgb, `${dir}/cube-lcms.ppm`]);
const ref = readFileSync(`${dir}/cube-lcms.ppm`);
const refPx = ref.subarray(ref.length - W * H * 3);
const t = iccToSrgb(new Uint8Array(readFileSync(profile)));
if (!t) { console.log("no transform (sRGB or unsupported)"); process.exit(0); }
const ours = px.slice();
t.applyRgb(ours, W * H);
const d = Array.from(ours, (v, i) => Math.abs(v - refPx[i])).sort((a, b) => a - b);
console.log(JSON.stringify({ profile: t.description, model: t.model, max: d[d.length - 1], mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(3), p99: d[Math.floor(d.length * 0.99)] }));
