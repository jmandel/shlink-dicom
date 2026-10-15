// Versions of the C/C++-in-wasm packages and whether their decoder builds use wasm SIMD. Node only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH } from "./corpus.mjs";

const PKGS = {
  "libjpeg-turbo-8bit": ["codec-libjpeg-turbo-8bit", "libjpegturbowasm_decode.wasm"],
  charls: ["codec-charls", "charlswasm_decode.wasm"],
  openjpeg: ["codec-openjpeg", "openjpegwasm_decode.wasm"],
  openjph: ["codec-openjph", "openjphjs.wasm"],
};

/** Count of SIMD (v128) instructions, via `wasm-tools print`; null when wasm-tools is missing. */
export function simdInstructions(wasmPath) {
  const tool = `${process.env.HOME}/.cargo/bin/wasm-tools`;
  if (!existsSync(tool)) return null;
  const text = execFileSync(tool, ["print", wasmPath], { maxBuffer: 1 << 30 }).toString();
  return (text.match(/\b(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./g) ?? []).length;
}

export function cwasmPackages() {
  const out = {};
  for (const [name, [pkg, wasm]] of Object.entries(PKGS)) {
    const dir = join(BENCH, "node_modules", "@cornerstonejs", pkg);
    if (!existsSync(dir)) { out[name] = { missing: "run npm ci in codecs/bench" }; continue; }
    out[name] = {
      package: `@cornerstonejs/${pkg}`,
      version: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version,
      wasm: wasm, simd_instructions: simdInstructions(join(dir, "dist", wasm)),
    };
  }
  return out;
}
