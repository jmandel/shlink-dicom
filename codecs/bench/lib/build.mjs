// Builds the decoder in each benchmarked form. Node only.
//
// Every build uses the workspace release profile (opt-level 3, debug = 1) with
// lto = "fat" and codegen-units = 1 set through CARGO_PROFILE_RELEASE_* (codecs/Cargo.toml
// is not changed). Each form has its own target directory under codecs/target/bench/.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BENCH, CODECS } from "./corpus.mjs";

export const OUT = join(CODECS, "target", "bench", "out");
/** Where runners read binaries from: a per-run snapshot (see snapshotBuilds), never OUT directly,
 *  so a concurrent run rebuilding OUT cannot change or lock files under a running benchmark. */
let RUN_DIR = OUT;
export const binDir = () => RUN_DIR;
export const LOCK = join(BENCH, ".build.lock");
const CARGO = [`${process.env.HOME}/.cargo/bin/cargo`, "+stable"];
export const PROFILE = { "opt-level": 3, lto: "fat", "codegen-units": 1, debug: 1, panic: "unwind" };
const PROFILE_ENV = { CARGO_PROFILE_RELEASE_LTO: "fat", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1" };

// Native builds: on x86_64 the benchmark's `native` is x86-64-v3 (AVX2), as the speed records have
// always been measured, and `native-base` is the baseline target that ordinary builds use
// (codecs/README.md, "CPU targets"). On other hosts both are the default target.
const X86 = process.arch === "x64";
/** The file a native build is written to. */
export const nativeBinary = (name) => (name === "native" ? "bench-native" : `bench-${name}`);
export const BUILDS = {
  native: { rustflags: X86 ? "-C target-cpu=x86-64-v3" : "", target: null, about: X86 ? "native release binary, x86-64-v3 (AVX2)" : `native release binary (${process.arch})` },
  "native-base": { rustflags: "", target: null, about: X86 ? "native release binary, baseline x86-64 (the default)" : `native release binary (${process.arch})` },
  "wasm-base": { rustflags: "", target: "wasm32-unknown-unknown", about: "wasm32, Rust's default wasm features, no SIMD" },
  "wasm-simd": { rustflags: "-C target-feature=+simd128", target: "wasm32-unknown-unknown", about: "wasm32 + simd128" },
  "wasm-relaxed": { rustflags: "-C target-feature=+simd128,+relaxed-simd", target: "wasm32-unknown-unknown", about: "wasm32 + simd128 + relaxed-simd" },
  // Post-processed with binaryen's wasm-opt (see WASM_OPT below); built from the build named in `from`.
  "wasm-base-opt": { from: "wasm-base", about: "wasm-base, then wasm-opt" },
  "wasm-simd-opt": { from: "wasm-simd", about: "wasm-simd, then wasm-opt" },
};

/** wasm-opt settings for the *-opt builds. The level was chosen by comparing -O3, -O4 and -Oz
 *  (see README "wasm-opt"). -g keeps the name section, so the optimised builds stay profilable;
 *  the sizes reported are with all custom sections stripped, as for every build. */
export const WASM_OPT = { bin: process.env.WASM_OPT ?? `${process.env.HOME}/.local/bin/wasm-opt`, level: process.env.WASM_OPT_LEVEL ?? "-O3" };

// target_features entry (written by LLVM) -> wasm-opt flag
const FEATURE_FLAGS = {
  "bulk-memory": "--enable-bulk-memory", "bulk-memory-opt": "--enable-bulk-memory-opt", "call-indirect-overlong": "--enable-call-indirect-overlong",
  multivalue: "--enable-multivalue", "mutable-globals": "--enable-mutable-globals", "nontrapping-fptoint": "--enable-nontrapping-float-to-int",
  "reference-types": "--enable-reference-types", "sign-ext": "--enable-sign-ext", simd128: "--enable-simd", "relaxed-simd": "--enable-relaxed-simd",
};

function customSections(wasm) {
  const out = [];
  let p = 8;
  while (p < wasm.length) {
    const start = p, id = wasm[p++];
    let size; [size, p] = leb(wasm, p);
    let name = null;
    if (id === 0) { let q, n; [n, q] = leb(wasm, p); name = wasm.subarray(q, q + n).toString(); }
    out.push({ id, name, start, end: p + size, body: p });
    p += size;
  }
  return out;
}

/** The features a build was compiled with, from its target_features section. */
export function targetFeatures(wasm) {
  const s = customSections(wasm).find((x) => x.name === "target_features");
  if (!s) return [];
  let p = s.body, n;
  [n, p] = leb(wasm, p); p += n; // section name
  let count; [count, p] = leb(wasm, p);
  const feats = [];
  for (let i = 0; i < count; i++) {
    const prefix = String.fromCharCode(wasm[p++]);
    let len; [len, p] = leb(wasm, p);
    if (prefix === "+") feats.push(wasm.subarray(p, p + len).toString());
    p += len;
  }
  return feats;
}

/** Drop DWARF (.debug_*) sections, keep everything else (names, target_features). */
function stripDwarf(wasm) {
  return Buffer.concat([wasm.subarray(0, 8), ...customSections(wasm).filter((x) => !x.name?.startsWith(".debug")).map((x) => wasm.subarray(x.start, x.end))]);
}

/** Run wasm-opt on a built wasm file; returns the flags used. */
export function runWasmOpt(src, dst, level = WASM_OPT.level) {
  const input = readFileSync(src);
  const feats = targetFeatures(input);
  const unknown = feats.filter((f) => !FEATURE_FLAGS[f]);
  if (unknown.length) throw new Error(`no wasm-opt flag known for target feature(s) ${unknown.join(", ")}`);
  const flags = [level, "-g", ...feats.map((f) => FEATURE_FLAGS[f])];
  const tmp = `${dst}.in.wasm`;
  writeFileSync(tmp, stripDwarf(input));
  execFileSync(WASM_OPT.bin, [...flags, tmp, "-o", dst], { stdio: ["ignore", "ignore", "inherit"] });
  rmSync(tmp);
  return flags;
}

/** Remove custom sections (name, DWARF, producers): the size a shipped build would have. */
export function stripCustomSections(wasm) {
  const out = [wasm.subarray(0, 8)];
  let p = 8;
  while (p < wasm.length) {
    const start = p, id = wasm[p++];
    let size = 0, shift = 0, b;
    do { b = wasm[p++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const end = p + size;
    if (id !== 0) out.push(wasm.subarray(start, end));
    p = end;
  }
  return Buffer.concat(out);
}

const leb = (buf, p) => {
  let v = 0, shift = 0, b;
  do { b = buf[p++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
  return [v, p];
};
const lebBytes = (v) => {
  const out = [];
  do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};

/**
 * Rewrite the function names in the wasm "name" section with demangled Rust names (rustfilt),
 * so DevTools profiles show `shl_codec_jpeg::dct::DctDecoder::idct_into` instead of `_RNv...`.
 * Returns the wasm unchanged when rustfilt is not installed.
 */
export function demangleNames(wasm, log = console.error) {
  const rustfilt = `${process.env.HOME}/.cargo/bin/rustfilt`;
  const parts = [wasm.subarray(0, 8)];
  let p = 8, done = false;
  while (p < wasm.length) {
    const start = p, id = wasm[p++];
    let size; [size, p] = leb(wasm, p);
    const end = p + size;
    if (id === 0 && !done) {
      let q, nlen; [nlen, q] = leb(wasm, p);
      if (wasm.subarray(q, q + nlen).toString() === "name") {
        q += nlen;
        const subs = [];
        while (q < end) {
          const sid = wasm[q++];
          let slen; [slen, q] = leb(wasm, q);
          subs.push({ sid, body: wasm.subarray(q, q + slen) });
          q += slen;
        }
        const fn = subs.find((x) => x.sid === 1);
        if (fn) {
          let r = 0, count; [count, r] = leb(fn.body, r);
          const entries = [];
          for (let i = 0; i < count; i++) {
            let idx, len; [idx, r] = leb(fn.body, r); [len, r] = leb(fn.body, r);
            entries.push([idx, fn.body.subarray(r, r + len).toString()]);
            r += len;
          }
          let names;
          try {
            names = execFileSync(rustfilt, [], { input: entries.map((e) => e[1].replace(/\n/g, " ")).join("\n") + "\n", maxBuffer: 1 << 28 }).toString().split("\n");
          } catch {
            log("rustfilt not found (cargo install rustfilt): wasm profiles will show mangled names");
            return wasm;
          }
          const body = [lebBytes(count)];
          entries.forEach(([idx], i) => { const n = Buffer.from(names[i] ?? entries[i][1]); body.push(lebBytes(idx), lebBytes(n.length), n); });
          fn.body = Buffer.concat(body);
          const payload = Buffer.concat([lebBytes(4), Buffer.from("name"), ...subs.flatMap((x) => [Buffer.from([x.sid]), lebBytes(x.body.length), x.body])]);
          parts.push(Buffer.from([0]), lebBytes(payload.length), payload);
          done = true;
          p = end;
          continue;
        }
      }
    }
    parts.push(wasm.subarray(start, end));
    p = end;
  }
  return Buffer.concat(parts);
}

export function build(names, log = console.error) {
  mkdirSync(OUT, { recursive: true });
  const info = {};
  // An -opt build needs its source build first.
  const order = [...new Set(names.flatMap((n) => (BUILDS[n].from ? [BUILDS[n].from, n] : [n])))];
  for (const name of order) {
    const b = BUILDS[name];
    if (b.from) {
      const dst = join(OUT, `${name}.wasm`);
      const t0 = Date.now();
      const flags = runWasmOpt(join(OUT, `${b.from}.wasm`), dst);
      log(`build ${name}: wasm-opt ${flags.join(" ")}`);
      const raw = readFileSync(dst), stripped = stripCustomSections(raw);
      writeFileSync(join(OUT, `${name}.stripped.wasm`), stripped);
      info[name] = {
        about: b.about, from: b.from, rustflags: BUILDS[b.from].rustflags, wasm_opt: `${flags.join(" ")}`, wasm_opt_version: execFileSync(WASM_OPT.bin, ["--version"]).toString().trim(),
        target: "wasm32-unknown-unknown", profile: PROFILE, build_s: (Date.now() - t0) / 1000, path: dst,
        bytes_with_debug: raw.length, bytes: stripped.length, bytes_gzip: gzipSync(stripped, { level: 9 }).length,
      };
      continue;
    }
    const targetDir = join(CODECS, "target", "bench", name);
    const args = ["build", "--release", "-p", "shl-dicom-wasm-bench"];
    if (b.target) args.push("--target", b.target, "--lib");
    else args.push("--bin", "bench-native");
    log(`build ${name}: cargo ${args.join(" ")}  RUSTFLAGS="${b.rustflags}"`);
    // Every build sets RUSTFLAGS (even empty), so nothing from the caller's environment leaks in.
    const env = { ...process.env, ...PROFILE_ENV, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: b.rustflags };
    delete env.CARGO_ENCODED_RUSTFLAGS;
    for (const k of Object.keys(env)) if (/^CARGO_TARGET_.*_RUSTFLAGS$/.test(k)) delete env[k];
    const t0 = Date.now();
    execFileSync(CARGO[0], [CARGO[1], ...args], {
      cwd: CODECS, stdio: ["ignore", "ignore", "inherit"],
      env,
    });
    const host = execFileSync(CARGO[0], [CARGO[1], "-vV"]).toString().match(/^host: (.+)$/m)?.[1] ?? "unknown";
    const rec = { about: b.about, rustflags: b.rustflags, target: b.target ?? host, profile: PROFILE, build_s: (Date.now() - t0) / 1000 };
    if (b.target) {
      const src = join(targetDir, b.target, "release", "shl_dicom_wasm_bench.wasm");
      const dst = join(OUT, `${name}.wasm`);
      writeFileSync(dst, demangleNames(readFileSync(src), log));
      const raw = readFileSync(dst);
      const stripped = stripCustomSections(raw);
      writeFileSync(join(OUT, `${name}.stripped.wasm`), stripped);
      Object.assign(rec, {
        path: dst,
        bytes_with_debug: raw.length,
        bytes: stripped.length,
        bytes_gzip: gzipSync(stripped, { level: 9 }).length,
      });
    } else {
      const dst = join(OUT, nativeBinary(name));
      copyFileSync(join(targetDir, "release", "bench-native"), dst);
      rec.path = dst;
    }
    info[name] = rec;
  }
  let prev = {};
  try { prev = JSON.parse(readFileSync(join(OUT, "builds.json"), "utf8")); } catch {}
  const all = { ...prev, ...info };
  writeFileSync(join(OUT, "builds.json"), JSON.stringify(all, null, 2));
  return all;
}

export function buildInfo() {
  try { return JSON.parse(readFileSync(join(OUT, "builds.json"), "utf8")); } catch { return {}; }
}

/**
 * Build (unless noBuild) and copy the results to a run-unique directory, holding an exclusive
 * flock on bench/.build.lock for the whole step, so concurrent runs never build over each other
 * or copy a half-written file. Runners then use only the snapshot. Returns the build info.
 */
export function snapshotBuilds(names, { noBuild = false, log = console.error } = {}) {
  const dir = join(CODECS, "target", "bench", "runs", `${process.pid}-${Date.now()}`);
  const args = ["-x", LOCK, process.execPath, fileURLToPath(import.meta.url), "--snapshot", dir, ...(noBuild ? ["--no-build"] : []), ...names];
  log(`waiting for the build lock (${LOCK}) if another run holds it`);
  const out = execFileSync("flock", args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 }).toString();
  RUN_DIR = dir;
  return JSON.parse(out);
}

export function removeSnapshot() {
  if (RUN_DIR !== OUT) rmSync(RUN_DIR, { recursive: true, force: true });
}

// CLI used by snapshotBuilds (runs under flock): node lib/build.mjs --snapshot DIR [--no-build] BUILD...
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dir = argv[argv.indexOf("--snapshot") + 1];
  const noBuild = argv.includes("--no-build");
  const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--snapshot");
  const info = noBuild ? buildInfo() : build(names);
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const f = BUILDS[n].target === null ? nativeBinary(n) : `${n}.wasm`;
    copyFileSync(join(OUT, f), join(dir, f));
    if (info[n]) info[n].path = join(dir, f);
  }
  process.stdout.write(JSON.stringify(info));
}
