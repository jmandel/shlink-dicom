# Codecs

Pure-Rust pixel decoders and their wasm builds. Each format's decoder, test corpus and speed record are described under [`codec-corpus/formats/`](../codec-corpus/formats/); the benchmark harness is in [`bench/`](bench/README.md).

## CPU requirement

Native x86_64 builds in this repository target **x86-64-v3** (AVX2, BMI1, BMI2, FMA, MOVBE), set in the repository's [`.cargo/config.toml`](../.cargo/config.toml). The binaries run on Intel Haswell (2013) and AMD Excavator (2015) or later cores that have AVX2; some Intel Pentium and Celeron models lack it. On a CPU without these instructions they stop with an illegal-instruction error. wasm32 builds are not affected.

Compiling for x86-64-v3 lets LLVM vectorise with AVX2. Against the baseline x86-64 target it cut native decode cycles by 3–10% for JPEG 2000, 8–15% for HTJ2K, 8–11% for JPEG-LS (one case +2%) and 3–14% for JPEG XL, with identical output (`bench-native`, every bench case of those formats, October 2026).

To build for an older CPU, set `RUSTFLAGS`, which replaces the config file's flags:

```bash
RUSTFLAGS="-C target-cpu=x86-64" cargo build --release -p shl-dicom-decode
```

Any build that sets `RUSTFLAGS` for its own reasons (`cargo fuzz`, for example) also drops the config's target; add `-C target-cpu=x86-64-v3` to it to build the same code as a normal build.
