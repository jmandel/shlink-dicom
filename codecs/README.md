# Codecs

Pure-Rust pixel decoders and their wasm builds. Each format's decoder, test corpus and speed record are described under [`codec-corpus/formats/`](../codec-corpus/formats/); the benchmark harness is in [`bench/`](bench/README.md).

## CPU targets

Native builds use Rust's default target for the host: baseline x86-64 on Intel and AMD, aarch64 on Arm (Apple Silicon, Graviton, Ampere). The binaries run on any machine of that architecture, Linux or macOS. The only CPU feature the decoders use beyond the baseline is AVX2 in the JPEG decoder (`shl-codec-jpeg/src/simd.rs`), which is chosen at run time and has a scalar path; every other `cfg(target_arch)` in the codecs is a wasm32 simd128 kernel beside a portable one. wasm32 builds are not affected.

For the full speed of the machine you build on, x86 or Apple Silicon:

```bash
RUSTFLAGS="-C target-cpu=native" cargo build --release -p shl-dicom-decode
```

To build for x86-64-v3 (AVX2, BMI1, BMI2, FMA, MOVBE, LZCNT, F16C: Intel Haswell, AMD Excavator or newer) on any x86_64 Linux machine, without touching the wasm builds:

```bash
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --release -p shl-dicom-decode
```

The server's linux-x86_64 release carries such a build beside the baseline one, and the bootstrap installs it on CPUs with the whole v3 set (README.md, [Deploying](../README.md#deploying)).

Against the baseline target, x86-64-v3 cut native decode cycles by 3–10% for JPEG 2000, 8–15% for HTJ2K, 8–11% for JPEG-LS (one case +2%) and 3–14% for JPEG XL, with identical output (`bench-native`, every bench case of those formats, October 2026).

**Benchmarks.** `bench/run.mjs` builds `native` for x86-64-v3 on x86_64, as every speed record in `codec-corpus/formats/*/PERF.md` was measured, and `native-base` for the default target; each run's results record the flags of every build ([bench/README.md](bench/README.md#what-gets-measured)).
