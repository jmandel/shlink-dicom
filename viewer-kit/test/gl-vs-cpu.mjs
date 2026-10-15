// Shader vs CPU reference, pixel for pixel, on corpus frames (headless Chromium).
//
//   node viewer-kit/test/gl-vs-cpu.mjs
//
// For each case: decode with the pool, render frame 0 with GlRenderer into an OffscreenCanvas the
// size of the image and read it back, render the same view with renderCpu, compare every RGBA
// sample. Tolerance: ±1 per sample (the shader computes the window in float32, the CPU in
// float64; a value within float32 rounding of a .5 quantisation boundary can land one level
// apart). Any difference > 1 fails. Also checks a lose/restore context cycle redraws identically.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withHarness } from "../scripts/browser.mjs";
import { KIT } from "../scripts/build.mjs";

export const CASES = [
  ["uncompressed/pydicom-CT_small", "CT 128² s16, rescale"],
  ["uncompressed/gen-bench-ct512-u16", "CT 512² u16"],
  ["uncompressed/gen-bench-dx2048-u12", "DX 2048² u12"],
  ["jpeg-ls/ext-pylibjpeg-RG1_JLSL", "CR 1841×1955 15-bit"],
  ["uncompressed/idc-expl-mono1-u16of16-sf-mr-siemens-702ca69f", "MONOCHROME1 u16"],
  ["uncompressed/idc-expl-mono1-s16of16-sf-pt-gemedicals-9fcfadc9", "MONOCHROME1 s16 PT"],
  ["uncompressed/ext-gdcm-MR16BitsAllocated_8BitsStored", "s16, 8 bits stored"],
  ["jpeg2000/gen-synth-s12-40x40-openjpeg-cr20", "s12 J2K lossy"],
  ["jpeg-lossless/ext-gdcm-GE_DLX-8-MONO2-Multiframe-Jpeg_Lossless", "XA 8-bit multi-frame"],
  ["uncompressed/idc-expl-mono2-u1of1-sf-seg-stonybrook-9ff901d3", "1-bit SEG"],
  ["rle/pydicom-rtdose_rle_1frame", "RT dose u32"],
  ["rle/pydicom-OBXXXX1A_rle", "PALETTE COLOR 8-bit"],
  ["rle/ext-gdcm-rle16sti", "PALETTE COLOR 16-bit"],
  ["uncompressed/ext-gdcm-NM-PAL-16-PixRep1", "PALETTE COLOR s16"],
  ["htj2k/pydicom-HTJ2KLossless_08_RGB", "RGB 8-bit"],
  ["jpeg-dct/gen-bench-photo-rgb8-2048-ijg-baseline", "RGB 2048² JPEG"],
  ["rle/pydicom-SC_rgb_rle_16bit", "RGB 16-bit"],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await withHarness(async (page) => {
    const out = [];
    for (const [c, label] of CASES) {
      const r = await page.evaluate((url) => window.vk.glVsCpu({ url }), `/corpus/${c.split("/")[0]}/samples/${c.split("/")[1]}.dcm`);
      out.push({ case: c, label, ...r });
      const worst = Math.max(...(r.rows ?? []).map((x) => x.maxDiff));
      const diff = (r.rows ?? []).reduce((a, x) => a + x.differing, 0);
      const total = (r.rows ?? []).reduce((a, x) => a + x.samples, 0);
      console.log(`${worst <= 1 ? "ok  " : "FAIL"} ${label.padEnd(26)} ${String(r.info?.columns + "×" + r.info?.rows).padEnd(10)} max|d|=${worst}  differing=${diff}/${total}  ${r.contextLoss ?? r.error}`);
      if (worst > 1) for (const row of r.rows) if (row.maxDiff > 1) console.log("     ", row);
    }
    return out;
  });
  mkdirSync(join(KIT, "test", "results"), { recursive: true });
  writeFileSync(join(KIT, "test", "results", "gl-vs-cpu.json"), JSON.stringify(results, null, 1));
  const fail = results.some((r) => r.error || r.rows.some((x) => x.maxDiff > 1));
  console.log(`\nGPU: ${results[0]?.gpu}`);
  process.exit(fail ? 1 : 0);
}
