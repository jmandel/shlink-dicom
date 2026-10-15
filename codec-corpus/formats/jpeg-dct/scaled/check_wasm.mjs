// Check shl-codec-jpeg's decode_frame_scaled in wasm (base and simd128 builds) against the
// native build, frame 0 of every jpeg-dct case at 1/2, 1/4 and 1/8. The native output is checked
// against libjpeg-turbo by check_scaled.py, so equality here carries that over to wasm.
// Usage (from the repository root): node codec-corpus/formats/jpeg-dct/scaled/check_wasm.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const codecs = path.join(root, "codecs");
const target = process.env.CARGO_TARGET_DIR ?? path.join(codecs, "target/scaled");
const cargo = path.join(process.env.HOME, ".cargo/bin/cargo");
const env = (flags) => ({ ...process.env, CARGO_TARGET_DIR: path.join(target, flags ? "wasm-simd" : "wasm-base"), RUSTFLAGS: flags });
const builds = {};
for (const [name, flags] of [["base", ""], ["simd128", "-C target-feature=+simd128"]]) {
  execFileSync(cargo, ["+stable", "build", "-q", "--release", "-p", "shl-codec-jpeg", "--target", "wasm32-unknown-unknown", "--example", "scaled_wasm"], { cwd: codecs, env: env(flags), stdio: "inherit" });
  const file = path.join(env(flags).CARGO_TARGET_DIR, "wasm32-unknown-unknown/release/examples/scaled_wasm.wasm");
  builds[name] = (await WebAssembly.instantiate(fs.readFileSync(file))).instance.exports;
}
execFileSync("cargo", ["build", "-q", "--release", "-p", "shl-codec-jpeg", "--example", "scaled_dump"], { cwd: codecs, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: "inherit" });
const dump = path.join(target, "release/examples/scaled_dump");

const framesDir = path.join(root, "codec-corpus/formats/jpeg-dct/frames");
const photo = { MONOCHROME2: 0, MONOCHROME1: 0, RGB: 1, YBR_FULL: 2, YBR_FULL_422: 3 };
let compared = 0, bad = 0;
const tmp = fs.mkdtempSync(path.join(process.env.HOME, ".scaled-wasm-"));
for (const c of fs.readdirSync(framesDir).sort()) {
  const dir = path.join(framesDir, c);
  if (!fs.existsSync(path.join(dir, "frame-0.bin"))) continue;
  const info = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
  if (info.expect !== "decode" || !(info.photometric in photo)) continue;
  const cs = fs.readFileSync(path.join(dir, "frame-0.bin"));
  for (const s of [1, 2, 3]) {
    let native;
    try {
      execFileSync(dump, [dir, String(s), path.join(tmp, "n.raw")], { stdio: "pipe" });
      const all = fs.readFileSync(path.join(tmp, "n.raw"));
      native = all.subarray(0, all.length / info.frames);
    } catch { continue; } // native refuses: nothing to compare
    for (const [name, x] of Object.entries(builds)) {
      const p = x.alloc(cs.length);
      new Uint8Array(x.memory.buffer, p, cs.length).set(cs);
      const n = x.scaled(p, cs.length, info.rows, info.columns, info.samples_per_pixel, info.bits_allocated, info.bits_stored, photo[info.photometric], s);
      const got = n < 0 ? null : new Uint8Array(x.memory.buffer, x.out_ptr(), n);
      if (!got || Buffer.compare(Buffer.from(got), native) !== 0) {
        console.log(`${c} 1/${1 << s} ${name}: differs from native`);
        bad++;
      }
      compared++;
    }
  }
}
fs.rmSync(tmp, { recursive: true });
console.log(`${compared} comparisons, ${bad} differing`);
process.exit(bad ? 1 : 0);
