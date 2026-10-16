# JPEG 2000 and HTJ2K decode speed

`shl-jpeg2000` decodes both formats ([jpeg2000 FORMAT.md, Decoder](../jpeg2000/FORMAT.md#decoder)). This page gives its speed, natively and in wasm32, against the C libraries, and the cost of reduced-resolution decodes.

## How it was measured

- **Frames:** `../jpeg2000/extra/bench_frames.py OUT_DIR` writes synthetic smooth-plus-noise 16-bit frames (512² and 2048²) coded lossless by `opj_compress` and `ojph_compress`, and 640×480 RGB frames from the corpus. Added to them: frame 0 of corpus cases (`frames/<case>/frame-0.bin` and `info.json`), named in the tables by case.
- **Ours:** `codecs/shl-codec-jpeg2000/bench`, a crate outside the workspace (`lto`, one codegen unit). `shl-j2k-bench DIR` times `decode_frame` natively; `bench.mjs` times the same crate built for wasm32 with `+simd128` in node 24. Each figure is the median of 7 decodes (3 for codestreams over 2 MB), and includes the header checks and the output packing.
- **C libraries:** OpenJPEG 2.5.4 (one thread) and OpenJPH 0.32, both through imagecodecs 2026.10.10, timed in-process from Python on the same codestreams, median of 7 (3) decodes.
- **Machine:** Ryzen 5 3600 (12 threads), rustup stable. The [results](#results) come from the quiet run `quiet-full3` of 16 October 2026 (load average 1.2 when it started, the other agents idle), with the tools built from main at db16333.

## Results

Times in ms per frame; the last column is our native time over the faster C library's.

| Frame | native | wasm32 simd128 | OpenJPEG | OpenJPH | native ÷ fastest C |
|---|---|---|---|---|---|
| J2K 512² 16-bit lossless (synthetic) | 36.6 | 39.1 | 41.1 | – | 0.89× |
| J2K 2048² 16-bit lossless (synthetic) | 590.4 | 625.1 | 662.6 | – | 0.89× |
| J2K 640×480 RGB lossless | 25.9 | 28.2 | 26.5 | – | 0.98× |
| J2K 512² signed 16-bit CT lossless | 16.0 | 17.5 | 16.2 | – | 0.99× |
| J2K `pydicom-RG1_J2KR` (1841×1955, 15-bit, lossless) | 425.7 | 450.6 | 473.1 | – | 0.90× |
| J2K `pydicom-RG1_J2KI` (same, 9/7) | 100.1 | 108.6 | 93.8 | – | 1.07× |
| J2K `pydicom-US1_J2KR` (640×480 RGB, lossless) | 25.8 | 28.3 | 25.9 | – | 1.00× |
| J2K `pydicom-MR2_J2KI` (1024², 12-bit, 9/7) | 17.8 | 19.9 | 18.9 | – | 0.94× |
| J2K `gen-bench-ct512-u16-openjpeg-cr20` (9/7, 20:1) | 6.00 | 6.60 | 5.80 | – | 1.03× |
| J2K `gen-bench-photo-rgb8-2048-openjpeg-cr20` (RGB, ICT, 9/7) | 146.8 | 162.0 | 150.2 | – | 0.98× |
| J2K slide tile 256², Hamamatsu (ICT, 9/7) | 2.10 | 2.50 | 2.03 | – | 1.03× |
| J2K slide tile, Zeiss (ICT, 9/7) | 2.00 | 2.40 | 1.97 | – | 1.02× |
| J2K slide tile, BioImagene (ICT, 9/7) | 3.30 | 3.70 | 3.10 | – | 1.06× |
| J2K slide tile 240², Leica (4:2:2, 9/7) | 1.00 | 1.40 | 0.90 | – | 1.11× |
| HTJ2K 512² 16-bit lossless (synthetic) | 1.70 | 2.10 | 2.60 | 1.01 | 1.68× |
| HTJ2K 2048² 16-bit lossless (synthetic) | 38.9 | 38.9 | 47.4 | 17.4 | 2.23× |
| HTJ2K 640×480 RGB lossless | 6.50 | 7.40 | 9.19 | 3.29 | 1.98× |
| HTJ2K `pydicom-HTJ2K_08_RGB` (640×480 RGB) | 6.80 | 8.30 | 8.04 | 3.68 | 1.85× |
| HTJ2K `gen-bench-dx2048-u12-openjph-q` (2048², 12-bit, 9/7) | 30.7 | 31.4 | 31.2 | 9.34 | 3.29× |
| HTJ2K `gen-bench-photo-rgb8-2048-openjph-q` (RGB, 9/7) | 129.3 | 142.4 | 143.7 | 58.5 | 2.21× |


- **JPEG 2000** natively takes 0.89–1.11× OpenJPEG's time: 0.89–1.00× on lossless frames, where tier-1 (MQ) decoding is about 90% of the work, and 0.94–1.11× on 9/7 frames. The Leica tile is the slowest relative to OpenJPEG; our time includes the sYCC-to-RGB conversion of its subsampled chroma, which imagecodecs leaves undone.
- **HTJ2K** natively takes 1.7–3.3× OpenJPH's time and at most OpenJPEG's; the HT block decoder is about 55% of a decode.
- **wasm32 with simd128** runs within about 10% of native on most frames, and up to 1.4× native on the small slide tiles.
- **Against the C libraries in wasm**, from `codecs/bench/run.mjs` in the same quiet window (Chromium 154 worker, our codec stage against the Cornerstone packages' `decode()` only): JPEG 2000 takes 0.72–0.88× the time of `@cornerstonejs/codec-openjpeg`, and HTJ2K 1.17–1.20× that of `@cornerstonejs/codec-openjph` on 2048² frames and 0.82–1.04× on 640×480 and smaller.

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

## Changes in track T3

Track T3 of the [performance plan](../../../docs/PERF-PLAN.md#t3-jpeg-2000-decoder). Each figure is beside OpenJPEG 2.5.4 (one thread, through imagecodecs, the same codestream, median of 7 decodes) measured in the same session; ours with `shl-j2k-bench`, one core.

- **sYCC 4:2:2 and 4:2:0 output, by rows.** Subsampled colour (the Leica slide tiles) went through `pack` one sample at a time: a closure call per luma and per chroma sample, each rounding a float, then `sycc_to_rgb` per pixel. `pack` now takes whole rows (`Rows`), filled with the vectorisable `round_clamped` the other output path uses, and computes each chroma sample's three colour terms once for the pixels that share it. Leica 240×240 tile: 2.0 → 1.3 ms; OpenJPEG 1.35 ms, which does not convert the colour at all. The two Leica corpus files: 2,134M → 1,421M and 165M → 108M cycles per decode natively; in wasm 595M → 339M instructions on the second. Outputs identical (corpus at every scale, the long tail's 185 JPEG 2000 files, wasm equal to native).

- **Tier-1 instruction count (stopped).** On `pydicom-MR2_J2KI` (1024², 12-bit, 9/7) we run 164M instructions per decode natively against OpenJPEG's 117M, but in about the same cycles: 86–89M for OpenJPEG and 75–91M for us over several rounds at load 4–9 (ours includes the DICOM parse and output packing; both by `perf stat`, the difference of 22 and 2 decodes on one core). We have fewer branch misses (1.05M against 1.41M). The 1.39× of an earlier timing at load 3 did not hold up. Cleanup and significance propagation are 65% of our instructions, about 117 per MQ symbol (1.4M symbols, 46% of them renormalising). Three changes in a row were rejected:
  - a padding stripe above and below, so marking a sample significant needs no stripe check: 1% fewer instructions, cycles unchanged on MR2 and 4–5% more on the 2048² photo;
  - the column's state word held in a register across its four samples instead of reloaded from memory: 1.5% fewer instructions, cycles within 1–2% either way;
  - an MQ decode that branches on the sub-interval as T.800 Figures C.16–C.18 do, instead of selecting without branches: 8–9% fewer instructions, but 7% more cycles on MR2 and 13% more on lossless CT 512, where symbols are near 50/50 and the branch mispredicts.
  - **Next idea, not taken:** restructuring tier-1 the way OpenJPEG does (each column's flags in a register for the whole pass with the MQ registers as locals, and the coefficient's sign and magnitude written in place instead of in separate `mag` and sign bits). It is a rewrite of `t1.rs`, and the measured gap on the cases that dominate viewer use is 0.88–0.99× OpenJPEG for lossless and 1.05–1.09× for the slide tiles.

## Changes in track T5

Track T5 of the [performance plan](../../../docs/PERF-PLAN.md#t5-htj2k-block-decoder), a spike: decode MagSgn with wasm simd128 and keep it only if it saves at least 10% on the 2048² frames in wasm. It did not, and the track stopped. Times are medians from `codecs/bench/run.mjs` on 16 October 2026 at load average 4–5, in ms per frame; wasm is the codec stage in a Chromium worker, base and change built and run alternately.

The wasm profile (`codecs/bench/profile.mjs`) shows where the 2048² decodes go: MagSgn (`magsgn_row`) 36% of lossless DX, 16% of lossy DX and 27% of the RGB frame; the CxtVLC, MEL and U-VLC decoding (`vlc_row`) 21%, 16% and 21%. The VLC codes are read one after another, each depending on the last, so only MagSgn has lanes to fill.

- **The four samples of a quad from one buffer.** Each sample's bit offset is the sum of the `m_n` before it, so the four can be read from the same 64-bit buffer at once, with one shift of the buffer per quad instead of four. wasm 38.0 → 38.0 ms (DX lossless), 32.1 → 31.5 (DX lossy), 144 → 157 (RGB, noisy); natively 31.6 → 31.3, 24.2 → 24.0 and 121 → 122. Rejected.
- **A simd128 quad, as OpenJPH's wasm decoder does it.** Lane `n` gathers three bytes of the buffer at its offset with `i8x16_swizzle`, shifts them by the rest of the offset with a multiply from a table of powers of two, and builds the sample with lane-wise masks from a second table; one shift of the buffer per quad. All of it is safe Rust. A differential test checked it against the scalar samples on a million random quads. wasm over two alternating rounds: DX lossless 38.3 and 38.7 → 42.5 and 39.4 ms, DX lossy 31.4 and 31.5 → 33.0 and 31.1, RGB 149 and 151 → 149 and 151. Rejected.
- **The VLC decoding** was not tried: it is serial by construction, and the two MagSgn results above suggest that the arithmetic of a sample is not what limits the loop; the per-quad control (skipping empty quads, the exponent predictor, refilling the buffer) is the likelier cost, though it was not measured apart.

Beside these, in the same session: `@cornerstonejs/codec-openjph` in the same Chromium worker 33.2 ms (DX lossless), 28.2 (DX lossy) and 191 (RGB), against our 38.9, 32.9 and 148, so 1.17×, 1.17× and 0.78×; OpenJPH 0.32 natively (one thread, through imagecodecs) 14.2, 9.42 and 59.6 ms, against our native 32.8, 26.7 and 184 (2.31×, 2.83×, 3.09×; the RGB figure is high from load, 121–129 ms in quieter runs).

## What is left

- **Tier-1** is most of every decode: the MQ coder for JPEG 2000 (about 90% of a lossless decode) and the HT block decoder for HTJ2K (about 55%). Both are scalar. OpenJPH's SIMD MagSgn decoding, rebuilt in safe Rust for wasm simd128, did not help ([track T5](#changes-in-track-t5)).
- **Native vector width:** the wavelet and colour stages are vectorised by the compiler. Native builds target x86-64-v3 ([CPU requirement](../../../codecs/README.md#cpu-requirement)), so those loops use AVX2; in wasm32 with `+simd128` they use 128-bit vectors. Against the baseline x86-64 target (SSE2), x86-64-v3 cut `bench-native` cycles by 3.2–9.6% on the ten JPEG 2000 bench cases and 7.9–14.6% on the eight HTJ2K cases, with identical output (minimum of 3 alternating runs, load about 3). The [results table](#results) was measured before that change.
