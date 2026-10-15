// Build viewer-kit: the decoder wasm (simd128, the bench's release profile) and the TS bundles.
//
//   node viewer-kit/scripts/build.mjs            # wasm + bundles
//   node viewer-kit/scripts/build.mjs --no-wasm  # bundles only
//
// Output in viewer-kit/dist/:
//   shl_dicom_decode.wasm   custom sections stripped (what ships)
//   decoder-worker.js       the pool's worker script
//   viewer-kit.js           decoder-pool + gl-renderer + cpu-render, as one ES module
//   demo.js, harness.js     the demo page and the test/bench page
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { stripCustomSections } from "../../codecs/bench/lib/build.mjs";

export const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(KIT, "..");
export const DIST = join(KIT, "dist");
const CODECS = join(ROOT, "codecs");

export function buildWasm(log = console.error) {
  const targetDir = join(CODECS, "target", "viewer-kit-wasm");
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    // Same as codecs/bench (lib/build.mjs): workspace release profile + fat LTO + 1 CGU.
    CARGO_PROFILE_RELEASE_LTO: "fat",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    RUSTFLAGS: "-C target-feature=+simd128",
  };
  const t0 = Date.now();
  execFileSync(`${process.env.HOME}/.cargo/bin/cargo`, ["+stable", "build", "--release", "-p", "shl-dicom-decode-wasm", "--target", "wasm32-unknown-unknown", "--lib"], {
    cwd: CODECS, env, stdio: ["ignore", "ignore", "inherit"],
  });
  const raw = readFileSync(join(targetDir, "wasm32-unknown-unknown", "release", "shl_dicom_decode_wasm.wasm"));
  const stripped = stripCustomSections(raw);
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "shl_dicom_decode.wasm"), stripped);
  log(`wasm: ${(stripped.length / 1024).toFixed(0)} KiB stripped, ${(gzipSync(stripped, { level: 9 }).length / 1024).toFixed(0)} KiB gzip (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

export function buildBundles(log = console.error) {
  mkdirSync(DIST, { recursive: true });
  const entries = [
    ["src/decoder-worker.ts", "decoder-worker.js"],
    ["src/index.ts", "viewer-kit.js"],
    ["demo/demo.ts", "demo.js"],
    ["test/harness.ts", "harness.js"],
  ];
  for (const [src, out] of entries) {
    execFileSync("bun", ["build", join(KIT, src), "--outfile", join(DIST, out), "--target", "browser", "--format", "esm"], { stdio: ["ignore", "ignore", "inherit"] });
  }
  log(`bundles: ${entries.map((e) => e[1]).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes("--no-wasm")) buildWasm();
  buildBundles();
}
