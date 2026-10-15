// DecoderPool behaviour in headless Chromium: typed errors, transfer, priority, dedupe, abort,
// and decodeFrames == decode.   node viewer-kit/test/pool.mjs
import { withHarness } from "../scripts/browser.mjs";
const checks = await withHarness((page) => page.evaluate(() => window.vk.poolSemantics({
  big: "/corpus/jpeg2000/samples/gen-bench-ct512-u16-openjpeg-rev.dcm",
  multiframe: "/corpus/jpeg-lossless/samples/ext-gdcm-GE_DLX-8-MONO2-Multiframe-Jpeg_Lossless.dcm",
  unsupported: "/corpus/uncompressed/samples/ext-orthanc-2026-05-26-oob-monochrome-65535.dcm",
  jpeg: "/corpus/jpeg-dct/samples/gen-bench-photo-rgb8-2048-ijg-baseline.dcm",
})));
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
