# JPEG 2000 and HTJ2K decode speed

`shl-jpeg2000` decodes both formats ([jpeg2000 FORMAT.md, Decoder](../jpeg2000/FORMAT.md#decoder)). This page gives its speed, natively and in wasm32, against the C libraries, and the cost of reduced-resolution decodes.

## How it was measured

- **Frames:** `../jpeg2000/extra/bench_frames.py OUT_DIR` writes synthetic smooth-plus-noise 16-bit frames (512² and 2048²) coded lossless by `opj_compress` and `ojph_compress`, and 640×480 RGB frames from the corpus. Added to them: frame 0 of corpus cases (`frames/<case>/frame-0.bin` and `info.json`), named in the tables by case.
- **Ours:** `codecs/shl-codec-jpeg2000/bench`, a crate outside the workspace (`lto`, one codegen unit). `shl-j2k-bench DIR` times `decode_frame` natively; `bench.mjs` times the same crate built for wasm32 with `+simd128` in node 24. Each figure is the median of 7 decodes (3 for codestreams over 2 MB), and includes the header checks and the output packing.
- **C libraries:** OpenJPEG 2.5.4 (one thread) and OpenJPH 0.32, both through imagecodecs 2026.10.10, timed in-process from Python on the same codestreams, median of 7 (3) decodes.
- **Machine:** Ryzen 5 3600 (12 threads), rustup stable; load average 2–4 while measuring.

## Results

Times in ms per frame; the last column is our native time over the faster C library's.

| Frame | native | wasm32 simd128 | OpenJPEG | OpenJPH | native ÷ fastest C |
|---|---|---|---|---|---|
| J2K 512² 16-bit lossless (synthetic) | 48.8 | 50.0 | 41.3 | – | 1.18× |
| J2K 2048² 16-bit lossless (synthetic) | 793.5 | 803.8 | 657.2 | – | 1.21× |
| J2K 640×480 RGB lossless | 29.6 | 31.0 | 25.7 | – | 1.15× |
| J2K 512² signed 16-bit CT lossless | 18.6 | 19.4 | 16.0 | – | 1.16× |
| J2K `pydicom-RG1_J2KR` (1841×1955, 15-bit, lossless) | 551.7 | 565.8 | 472.8 | – | 1.17× |
| J2K `pydicom-RG1_J2KI` (same, 9/7) | 121.2 | 118.8 | 94.4 | – | 1.28× |
| J2K `pydicom-US1_J2KR` (640×480 RGB, lossless) | 29.8 | 31.4 | 25.9 | – | 1.15× |
| J2K `pydicom-MR2_J2KI` (1024², 12-bit, 9/7) | 20.3 | 21.5 | 19.3 | – | 1.05× |
| J2K `gen-bench-ct512-u16-openjpeg-cr20` (9/7, 20:1) | 5.70 | 6.20 | 5.53 | – | 1.03× |
| J2K `gen-bench-photo-rgb8-2048-openjpeg-cr20` (RGB, ICT, 9/7) | 158.7 | 166.5 | 150.2 | – | 1.06× |
| J2K slide tile 256², Hamamatsu (ICT, 9/7) | 2.30 | 2.50 | 1.96 | – | 1.17× |
| J2K slide tile, Zeiss (ICT, 9/7) | 2.20 | 2.40 | 1.96 | – | 1.12× |
| J2K slide tile, BioImagene (ICT, 9/7) | 3.50 | 3.90 | 2.98 | – | 1.17× |
| J2K slide tile 240², Leica (4:2:2, 9/7) | 1.70 | 2.50 | 0.86 | – | 1.98× |
| HTJ2K 512² 16-bit lossless (synthetic) | 1.70 | 2.10 | 2.55 | 1.00 | 1.70× |
| HTJ2K 2048² 16-bit lossless (synthetic) | 40.0 | 38.8 | 48.9 | 17.1 | 2.34× |
| HTJ2K 640×480 RGB lossless | 6.40 | 7.40 | 9.00 | 3.24 | 1.98× |
| HTJ2K `pydicom-HTJ2K_08_RGB` (640×480 RGB) | 6.80 | 8.20 | 8.13 | 3.74 | 1.82× |
| HTJ2K `gen-bench-dx2048-u12-openjph-q` (2048², 12-bit, 9/7) | 31.0 | 30.4 | 30.6 | 9.43 | 3.29× |
| HTJ2K `gen-bench-photo-rgb8-2048-openjph-q` (RGB, 9/7) | 127.7 | 142.0 | 141.2 | 58.0 | 2.20× |


- **JPEG 2000** natively takes 1.03–1.28× OpenJPEG's time, and lossless frames about 1.15–1.2×, where tier-1 (MQ) decoding is about 90% of the work. The Leica tile is the outlier: our time includes the sYCC-to-RGB conversion of its subsampled chroma, which imagecodecs leaves undone.
- **HTJ2K** natively takes 1.7–3.3× OpenJPH's time and at most about OpenJPEG's (within 1%); the HT block decoder is about 55% of a decode.
- **wasm32 with simd128** runs within about 10% of native on most frames, and up to 1.5× native on the small slide tiles.

## Reduced-resolution decode

`decode_frame_scaled` decodes at 1/2^s by discarding the s highest resolution levels ([jpeg2000 FORMAT.md, Reduced-resolution decode](../jpeg2000/FORMAT.md#reduced-resolution-decode)). Their code-blocks are never decoded. The table compares it with what a thumbnail costs without it: a full decode followed by a box downsample.

- **Tool:** `cargo run --release -p shl-codec-htj2k --example scaled_bench -- <frames dir> 20`, on frame 0; the minimum of 20 decodes, natively. The box downsample alone costs about 1 ms (12-bit mono) and 2 ms (RGB) at 1/8 on the 2048² frames.
- **Counts:** user-mode instructions per decode from `perf stat` over 20 decodes of `scaled_bench <dir> 20 loop S` (reduced) and `loopfull S` (full decode plus box), start-up and reading the file included. Times are the minimum of 20 decodes; the load average was 3–4, so times are only a guide and the instruction counts are the firmer figure.

| Case | Scale | Full decode + box: instructions / min time | Reduced decode: instructions / min time | Instruction ratio |
|---|---|---|---|---|
| JPEG 2000 `gen-bench-dx2048-u12-openjpeg-rev` (2048², 12-bit, lossless) | 1/8 | 2,603M / 337 ms | 45M / 5.5 ms | 58× |
|  | 1/4 | 2,621M / 338 ms | 159M / 19.7 ms | 16× |
|  | 1/2 | 2,683M / 338 ms | 632M / 80.7 ms | 4.2× |
| JPEG 2000 `gen-bench-dx2048-u12-openjpeg-cr20` (2048², 12-bit, 9/7 at 20:1) | 1/8 | 507M / 62.4 ms | 27M / 3.0 ms | 19× |
|  | 1/4 | 524M / 63.0 ms | 63M / 6.8 ms | 8.3× |
|  | 1/2 | 586M / 64.9 ms | 164M / 17.9 ms | 3.6× |
| JPEG 2000 `gen-bench-photo-rgb8-2048-openjpeg-cr20` (2048², 8-bit RGB, ICT, 9/7) | 1/8 | 1,312M / 151 ms | 95M / 12.1 ms | 14× |
|  | 1/4 | 1,345M / 153 ms | 231M / 27.4 ms | 5.8× |
|  | 1/2 | 1,453M / 163 ms | 567M / 64.2 ms | 2.6× |
| HTJ2K `gen-bench-dx2048-u12-openjph-rev` (2048², 12-bit, lossless) | 1/8 | 392M / 40.9 ms | 8M / 0.83 ms | 49× |
|  | 1/4 | 410M / 40.4 ms | 25M / 1.96 ms | 16× |
|  | 1/2 | 472M / 41.9 ms | 96M / 7.2 ms | 4.9× |
| HTJ2K `gen-bench-photo-rgb8-2048-openjph-q` (2048², 8-bit RGB, 9/7) | 1/8 | 1,241M / 137 ms | 27M / 2.1 ms | 46× |
|  | 1/4 | 1,274M / 141 ms | 86M / 7.2 ms | 15× |
|  | 1/2 | 1,383M / 149 ms | 312M / 28.8 ms | 4.4× |

Each level discarded removes about three quarters of the remaining code-blocks and of the wavelet synthesis, so the saving compounds. It is largest for lossless JPEG 2000, where MQ tier-1 decoding of the finest levels is almost all of the full decode's cost.

## What is left

- **Tier-1** is most of every decode: the MQ coder for JPEG 2000 (about 90% of a lossless decode) and the HT block decoder for HTJ2K (about 55%). Both are scalar. OpenJPH decodes MagSgn with SIMD; that approach needs per-lane variable shifts, and `#![forbid(unsafe_code)]` rules out raw intrinsics.
- **Native vector width:** the wavelet and colour stages are vectorised by the compiler for the default x86-64 target (SSE2). Choosing AVX2 at run time needs `unsafe` to call a `#[target_feature]` function. In wasm32 with `+simd128` the same loops use 128-bit vectors.
