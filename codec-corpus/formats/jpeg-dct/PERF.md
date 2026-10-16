# jpeg-dct and jpeg-lossless decoder speed

This page records the speed work on `shl-codec-jpeg` (October 2026). The decoder stays bit-identical to IJG libjpeg 6b throughout; [Exactness](#exactness) lists the checks.

## Cases

| Case | Image | Why it is here |
|---|---|---|
| `pydicom-color3d_jpeg_baseline` | 640×480, 8-bit YCbCr 4:2:2, 120 frames | typical colour cine (ultrasound, endoscopy) |
| `gen-bench-photo-rgb8-2048-ijg-baseline` | 2048×2048, 8-bit YCbCr 4:2:2 | large colour (slide microscopy tiles, photos) |
| `local-wrist-lateral` | 2320×2920, 12-bit mono, process 4 | radiograph, high quality |
| `gen-bench-dx2048-u12-ijg-extended` | 2048×2048, 12-bit mono, process 4 | synthetic radiograph |
| `gen-bench-dx2048-u12-ijg-lossless-sv1` | 2048×2048, 12 bits stored, lossless SV1 | large lossless |
| `gen-bench-ct512-u16-ijg-lossless-sv1` | 512×512, 16-bit, lossless SV1 | CT slice |

## Method

- **Machine:** AMD Ryzen 5 3600 (Zen 2, AVX2), Linux.
- **Native builds:** release profile, default x86-64 target. AVX2 kernels are chosen at run time.
- **Timing:** codec only. Frames are read into memory first, then decoded repeatedly (`cargo run --release --example bench -- <frames dir> <passes>`), and the minimum time per frame is reported.
- **Load:** other agents' fuzzers shared the machine during this work, so wall time was noisy.
  - Steps were judged by user-mode instruction and cycle counts (`perf stat`) and by A/B runs that alternate binaries.
  - The [final comparison](#final-comparison) was run back to back in a quiet period.
- **wasm:** a small `cdylib` around `decode_frame`, built with `lto = "fat"` and run in Node 24 (V8), with and without `-C target-feature=+simd128`.
- **References:**
  - [`perf_refs.py`](perf_refs.py) times libjpeg-turbo 3.2.0 (through Pillow, and through libturbojpeg's `tj3Decompress8/12/16`, which also cover 12-bit and lossless) and pylibjpeg (Richter's libjpeg), both from memory.
  - It also times DCMTK `dcmdjpeg`, which is a whole process with DICOM file I/O, so its single-frame times are upper bounds.

## Step by step

Native, ms per frame, as measured after each step. Later rows were measured at a lower machine load than earlier ones, so compare neighbouring rows, not distant ones; the [final comparison](#final-comparison) gives the end-to-end numbers. "Exact" means every corpus output was byte-identical to the previous build (see [Exactness](#exactness)).

| # | Change | colour 640×480 | wrist 12-bit | dx2048 lossless | ct512 lossless | Exact |
|---|---|---|---|---|---|---|
| 0 | Original | 5.06 | 54.4 | 72.8 | 4.27 | — |
| 1 | Output path: upsample and colour-convert one row at a time straight into the output bytes; no full-size intermediate planes or per-sample `extend_from_slice` | 4.10 | 52.7 | 53.2 | 2.94 | yes |
| 2 | IDCT in 32-bit arithmetic with an exact 64-bit fallback; flat (DC-only) blocks filled directly | 2.75 | 43.2 | 50.3 | 2.84 | yes |
| 3 | Bit reader takes up to 7 bytes at once when none is 0xFF; AC code, run and value from one table lookup; branchless sign extension | 2.40 | 32.4 | 37.7 | 2.41 | yes |
| 4 | Lossless decoded row by row with slices instead of per-sample closures; DC/lossless code and difference from one lookup | 2.47 | 31.7 | 29.1 | 1.88 | yes |
| 5 | Lookahead table 9 → 10 bits (11 and 12 were slower) | 2.43 | 32.7 | 22.6 | 1.60 | yes |
| 6 | AVX2 IDCT (explicit intrinsics) and simd128 IDCT | — | 329 → 184 M instructions | — | — | yes |
| 7 | Upsampling, colour conversion and output compiled a second time with AVX2 enabled | 1.80 | 20.8 | 22.2 | 1.57 | yes |
| 8 | Dequantisation moved from the entropy loop into the vector IDCT | 1.69 | 19.9 | 21.1 | 1.52 | yes |
| 9 | Bit buffer kept in registers in the DCT entropy loop | 1.70 | 20.4 | 23.3 | 1.62 | yes |
| 10 | 8-bit planes stored as `u8` instead of `u16` | 0.90 | 20.9 | 23.3 | 1.62 | yes |
| 11 | wasm simd128 kernels for YCbCr→RGB and h2v1 upsampling | native code unchanged | | | | yes |
| 12 | Bit buffer kept in registers in the lossless loop | 0.88 | 18.3 | 21.0 | 1.52 | yes |
| 13 | Lossless rows decoded by a loop specialised per predictor, with the left and upper neighbours in registers; the marker scan reads 8 bytes at a time | DCT unchanged | | 24.5 → 19.1 | 1.55 → 1.22 | yes |
| 14 | One-component lossless rows written straight to the output buffer | DCT unchanged | | 19.1 → 17.5 | 1.22 → 1.16 | yes |

Rows 13 and 14 are from the second speed round (decoder-perf, October 2026), measured back to back on saved binaries at load average 3–4 (minimum of 3 runs of `examples/bench`), so their absolute times are above row 12's quiet-machine figures; compare them with each other. Instructions per decode: dx2048 lossless 271M → 136M → 129M, ct512 17M → 9M → 8M. The [final comparison](#final-comparison) has quiet-machine numbers.

Rows 0–5 and 7 were measured in sequence during the work. Rows 8–12 come from the final run, which alternated the saved binaries back to back. Row 6 was measured under heavy load, so only its instruction count is given. Rows 8–10 move by up to 2 ms on the 12-bit and lossless cases from run to run; those code paths did not change in steps 9–11.

## Final comparison

Measured back to back on a quiet machine (load about 3). The values are the minimum ms per frame over the passes.

**Native.** Every reference decoder decodes from memory except `dcmdjpeg`, which runs as a separate process with DICOM file I/O.

| Case | Original | Now | Speed-up | libjpeg-turbo 3.2 (tj3) | libjpeg-turbo (Pillow) | pylibjpeg | dcmdjpeg |
|---|---|---|---|---|---|---|---|
| colour 640×480 | 4.96 | 0.88 | 5.6× | 0.82 | 1.07 | 7.78 | 3.02 |
| photo 2048² colour | 58.4 | 14.2 | 4.1× | 11.7 | 13.2 | 102.4 | 59.6 |
| wrist 2320×2920 12-bit | 54.8 | 18.3 | 3.0× | 31.8 | n/a | 121.9 | 72.0 |
| dx2048 12-bit DCT | 39.7 | 15.3 | 2.6× | 22.8 | n/a | 84.6 | 56.2 |
| dx2048 lossless | 73.9 | 21.0 | 3.5× | 24.0 | n/a | 155.8 | 64.3 |
| ct512 16-bit lossless | 4.22 | 1.52 | 2.8× | 1.33 | n/a | 8.71 | 19.1 |

Pillow decodes only 8-bit JPEG. libjpeg-turbo's 12-bit and lossless paths go through `tj3Decompress12/16`.

**wasm in Node 24** (V8). "Speed-up" compares the final simd128 build with the original simd128 build.

| Case | Original, no SIMD | Original, simd128 | Now, no SIMD | Now, simd128 | Speed-up |
|---|---|---|---|---|---|
| colour 640×480 | 4.88 | 4.72 | 3.01 | 1.56 | 3.0× |
| photo 2048² colour | 72.5 | 71.8 | 60.7 | 26.2 | 2.7× |
| wrist 2320×2920 12-bit | 69.3 | 69.7 | 51.2 | 26.5 | 2.6× |
| dx2048 12-bit DCT | 51.8 | 51.8 | 34.0 | 20.2 | 2.6× |
| dx2048 lossless | 108.6 | 110.3 | 26.7 | 24.8 | 4.4× |
| ct512 16-bit lossless | 6.06 | 6.07 | 1.60 | 1.47 | 4.1× |

The original decoder gained nothing from simd128, because almost none of its code vectorised. The build without SIMD gains from every scalar change.

## What helped

- **Removing whole-image passes (step 1).** The original decoder upsampled every component into a full-size `Vec<u16>`, interleaved those into another, then converted that to bytes one `extend_from_slice` at a time. Writing each output row once, straight from the planes, removed three full-image passes and most page faults.
- **32-bit IDCT and flat blocks (step 2).** The IDCT ran in `i64`. A bound proved by a test shows that the column pass cannot overflow 32 bits when every dequantised coefficient is within ±32767, and that the row pass is exact modulo 2^32, which is all its output uses. Blocks outside that bound, which only corrupt data produces, take the 64-bit path. DC-only blocks, common in chroma and smooth areas, skip the transform.
- **Entropy decoding (steps 3–5).**
  - Fewer refills, each taking several bytes at once.
  - Tables that return code, run and value together.
  - A 10-bit lookahead, which suits 12- and 16-bit data whose differences need more bits.
  - These matter most for lossless and high-quality 12-bit images, where entropy decoding is most of the time.
- **SIMD where the data is wide (steps 6, 7, 8, 11).**
  - The IDCT runs 8 columns, then 8 rows, per instruction, with the range limit computed arithmetically instead of by table lookup.
  - Upsampling and colour conversion vectorise: auto-vectorised on x86 with AVX2 enabled, explicit kernels on wasm.
  - Dequantising inside the vector IDCT removed a multiply and a load from every coefficient in the serial entropy loop.
- **A lossless loop per predictor (steps 13 and 14).** Monomorphising the row loop on the predictor removes a per-sample branch and keeps Ra, Rb and Rc in registers between samples instead of reloading them from the row buffers; one-component rows then go straight into the output. This halved the instructions per lossless sample.
- **Half the memory traffic for 8-bit images (step 10).** 8-bit components stored as `u16` doubled the bytes written by the IDCT and read by upsampling and colour conversion. With `u8` planes, the 640×480 colour case went from 1.68 to 0.92 ms.

## What did not help

- **Keeping the bit buffer in registers for DCT (step 9).** It made no measurable difference to the DCT loop. Store-to-load forwarding already hid the memory round trip. The limit is the serial chain of table load, shift and next lookup, about 7–8 cycles per coefficient. Moving the lossless loop the same way (step 12) did help, because there the refill and table calls had blocked other optimisations.
- **Refilling to 32 bits once per symbol** instead of 16 (part of step 8's rework) was neutral on its own.
- **Lookahead tables of 11 or 12 bits** were slower than 10: they are larger tables with no fewer misses on typical data.
- **Relying on auto-vectorisation for the IDCT.** Written over `[i32; 8]` rows, LLVM vectorised the passes only partly and transposed through scalar moves, which was slower than the scalar code. Explicit intrinsics were needed.
- **Two lossless differences per table lookup.** A 12-bit table returning two codes and values at once cost 15–35% more cycles on four of five SV1 images: the branch between the one- and two-symbol cases mispredicts.
- **A 16-bit-lane IDCT** (libjpeg-turbo's `pmaddwd` regrouping, exact against `idct_small`). In wasm (`i32x4.dot_i16x8_s`) it ran 2–5% fewer instructions with no change in cycles; the SSE2 form ran 20% more instructions than the AVX2 32-bit kernel.
- **End-of-block and ZRL entries in the AC fast table,** so a block's end skips the slower lookup: no change in native cycles or wasm instructions.
- **`u8` planes on wasm without explicit kernels.** On x86 they were a large gain. On wasm, LLVM's auto-vectorisation of the `u8` upsampling and colour loops was worse than for `u16`, a 10–20% loss. The explicit simd128 kernels (step 11) made it a gain there too.

## Remaining gap to libjpeg-turbo

**Native:**
- **8-bit colour:** 7% slower than libjpeg-turbo on the 640×480 cine frame (0.88 against 0.82 ms) and 21% slower on the 2048² photo (14.2 against 11.7 ms). We are faster than libjpeg-turbo through Pillow on the small frame.
- **12-bit DCT:** 1.5–1.7× faster than libjpeg-turbo, whose 12-bit path has no SIMD.
- **Lossless:** 13% faster on the 2048² image and 14% slower on the 512² CT.

**wasm with simd128, against native libjpeg-turbo:**
- 8-bit colour takes 1.9× (cine) to 2.2× (photo) as long.
- 12-bit DCT is still faster than native libjpeg-turbo.
- Lossless is about level.

**Where the remaining time goes, and what could close it:**
- **Entropy decoding** is now about 40% of the 8-bit colour time and most of the 12-bit and lossless time. Each coefficient's table lookup depends on the previous one (about 7–8 cycles each), and SIMD cannot help with that. libjpeg-turbo is in the same position.
- **libjpeg-turbo's IDCT uses 16-bit lanes,** 16 per AVX2 register against our 8. The 128-bit form of that was tried (see [What did not help](#what-did-not-help)); a 256-bit form would have to transform two blocks at once.
- **Cache.** We decode the whole frame into component planes, then upsample and convert. libjpeg-turbo works one MCU row at a time in buffers that stay in cache, which is why the gap is larger on the 2048² photo than on the 640×480 frame. Streaming by MCU row is the largest remaining change, and the one most likely to pay on large colour images.
- **wasm** has only 128-bit vectors and V8's code generation. The 4:2:0 (h2v2) upsampler and 12-bit colour conversion still rely on auto-vectorisation there. Explicit kernels for them would help the less common layouts.

## SV1 on real CT series

Measured for track T1 of the [performance plan](../../../docs/PERF-PLAN.md#t1-sv1-decode-and-encode), on the live sample's abdomen CT (30 SV1 slices, 512², 16-bit signed), at load 1–2:

- **Speed:** our codec stage takes 31.2 ms for the 30 slices (sum of each slice's minimum over 20 decodes, natively, one core); libjpeg-turbo 3.2 (`tj3Decompress16`, from Python as in `perf_refs.py`) takes 49.0 ms (minimum of 9 passes). That is 0.64× libjpeg-turbo, so the 512² CT case is no longer behind; the 1.1× figure came from before steps 13 and 14.
- **Where the time goes:** on the first slice, `decode_rows` is 85% of the decode, about 12 cycles per sample. The serial chain of lookahead shift, table load and consume takes roughly 10, and 7% of that slice's samples need more than the 10-bit table (the slow lookup).
- **Rejected:** an 11-bit lookahead for lossless scans only (DCT tables kept at 10). It saved 4–5% cycles on one slice and cost 2% on another; over the 30 slices it was 0.7% slower (130.8M against 129.9M cycles), because building the larger tables for every slice costs about what the extra fast lookups save.
- **Stopped:** the remaining time is that serial chain, and libjpeg-turbo is already 1.6× slower here. The next idea, decoding two fast-path differences per buffer check, would save about one compare and branch per sample, off the chain.

## SV1 encoder

`encode.rs` writes the SV1 streams that every share is packed with ([performance plan, T1](../../../docs/PERF-PLAN.md#t1-sv1-decode-and-encode)). Measured on the live sample's uncompressed series, one core (`taskset`), from memory, at load 2–3:

- **Ours, native:** `shl-dicom-transcode`'s `perf` example in `encode` mode (encoder only, from decoded pixels): native pixel bytes over the fastest of 7 passes over the series.
- **libjpeg-turbo 3.2:** `tj3Compress16` with `TJPARAM_LOSSLESS` 1, predictor 1, point transform 0, `TJPARAM_PRECISION` = Bits Stored, grayscale, the same frames from memory (in-process through ctypes); the same MB/s definition.
- **DCMTK 3.7 `dcmcjpeg +e1`:** whole processes, so its time is given net of `dcmconv` on the same files (reading and writing without compression). Per-process start-up still differs between the two tools, which makes the MR series (267 files) the least reliable.
- **wasm:** the whole SV1 transcode (both self-checks included) in Node with the `shl-dicom-transcode-wasm` build, user cycles per pass over the series. There is no reference SV1 encoder in wasm.

| Series | Ours native MB/s: main → now | libjpeg-turbo MB/s | dcmcjpeg +e1 MB/s, net of I/O | wasm transcode cycles per pass: main → now |
|---|---|---|---|---|
| abdomen CT, 93 slices, 16-bit | 202 → 343 | 74.6 | 66 | 1,627M → 1,163M (−29%) |
| brain MR, 267 images, 16-bit | 188 → 329 | 58.0 | 12 | 138M → 107–110M (−21%), one series |
| wrist X-ray, 3 images, 12-bit | 189 → 355 | 65.8 | 75 | 465M → 314–321M (−32%), one study |

- **What changed in the encoder (three commits):**
  - Each pass over the rows called its per-row work through `&mut dyn FnMut`, and the coding pass called `emit` and `BitWriter::put` per sample without inlining them, so the bit buffer went through memory for every sample. The row loop is now generic, `emit`, `put` and `category` are inlined, `put` no longer masks bits its callers already keep within `n`, and the check for a 0xFF byte in each flushed word is one word-wide test instead of four compares (native 201 → 240 MB/s on the CT series, wasm −11%).
  - The difference category and its extra bits are computed without branching on the sign. On noisy images the sign is random, so the branch mispredicted often in both passes: the `perf` run over the CT series went from 33M to 9M branch misses (native 243 → 339 MB/s, wasm −13–16%).
  - **Four partial histograms** in the counting pass (one-component images), so increments of the same category no longer wait on each other: wasm transcode of the CT series 1,467M → 1,413M cycles per pass (−3.7%); the MR series ran the same instructions (323M against 322M) and cycles within run-to-run spread, the X-ray study 2% fewer cycles.
- **The transcoder's pixel self-check** compares the decoded output with the input. `[u8]` equality became a `memcmp` call, which in wasm compares a byte at a time (5% of the CT transcode); `shl-dicom-transcode` now compares eight bytes at a time: CT 1,227M → 1,163M cycles per pass, MR and X-ray 2–5% fewer, native within 1%.
- **Rejected:**
  - Keeping all differences from the counting pass (16 bits each) instead of computing them again in the coding pass. It cost about 4% more cycles than recomputing them, and memory for the whole frame instead of three rows.
  - Inlining the per-row `differences`: 1.5% fewer wasm instructions, no cycle change.
  - Holding the bit buffer in locals across the coding loop, apart from the output `Vec`: about 2% fewer wasm instructions, native unchanged; not worth a second write path.
- **Exactness:** SV1 outputs of every live file (735 encoded, 4 declined, as before) and every corpus file are byte-identical to the previous build natively, and the wasm build's outputs equal the native ones.

## Exactness

Every step had to keep every jpeg-dct and jpeg-lossless corpus result unchanged:

1. **Byte gate.** `shl-dicom-decode` was run on every jpeg sample (347 files). Exit code and an output hash had to match the previous build.
2. **Corpus check.** `check.py --format jpeg-dct --format jpeg-lossless` was run. The only changed results are the two deliberate fixes and one ruling ([jpeg-lossless rulings](../jpeg-lossless/FORMAT.md#rulings)).
3. **SIMD against scalar.** Unit test `simd::tests::corpus_frames_match_scalar` decodes all 2,806 extracted corpus frames with the AVX2 kernels and with the scalar kernels and requires identical bytes.
4. **IDCT unit tests:**
   - Random blocks compare the 32-bit, AVX2 and simd128 paths with the 64-bit reference, for 8- and 12-bit, including coefficients beyond the 32-bit bound.
   - `small_bound_holds` proves that bound.
   - Separate tests check the arithmetic range limit against libjpeg's table, and the integer colour conversion against `jdcolor.c`'s tables.
5. **wasm.** The Node harness hashes every corpus case's output under wasm without SIMD and with simd128. All 347 match the native output, and match the original decoder apart from the two deliberate fixes.

## Recommendations for the other codecs

These recommendations are based on the codecs/bench results (`results/latest.json`, ct512 u16 cases, medians, recorded while the machine was loaded) and on what the JPEG work showed. Each codec should be profiled before it is changed.

| Codec | Native | Node simd128 | Recommendation |
|---|---|---|---|
| RLE | 0.30 ms | 0.40 ms | Leave it. It is close to a memory copy already; at most, write runs with `fill` and `copy_from_slice`. |
| JPEG-LS | 7.3 ms | 6.1 ms | Scalar work, not SIMD (see below). |

- **JPEG-LS:** decoding is serial per sample (context selection, Golomb codes and bias correction all depend on the previous sample), so SIMD has little to work on. The scalar changes that paid off here apply directly:
  - a bit reader that loads several bytes at once (JPEG-LS stuffs one bit after 0xFF instead of a zero byte, so the 0xFF test is the same);
  - `leading_zeros` for the unary part of Golomb codes;
  - row slices with padding instead of per-sample index arithmetic and bounds checks;
  - the bit buffer kept in registers across the sample loop.

  Steps 3, 4, 5 and 12 here, which were the same kind of change, gave about 2–2.5× on lossless JPEG (dx2048: 50.3 → 21.0 ms; ct512: 2.84 → 1.52 ms).

## Reduced-resolution decode

`decode_frame_scaled` (CONTRACT.md, "Reduced-resolution decode") decodes at 1/2, 1/4 or 1/8 through libjpeg's reduced IDCTs, instead of a full decode followed by a downsample. A viewer thumbnail at 1/8 of a 2048² image is 256², which a cheap second reduction takes to 64 px.

**Method:**

- **Machine:** the same Ryzen 5 3600, with a native release build; the AVX2 kernels are selected at run time.
- **Tool:** `cargo run --release --example scaled_bench -- <frames/CASE dir> <reps> loop S | loopfull S`, on frame 0.
  - `loop S` runs `decode_frame_scaled` at 1/2^S.
  - `loopfull S` runs `decode_frame` followed by the example's box downsample. That downsample is a row-summing loop that LLVM vectorises; at 1/8 it takes about 4 ms on the colour case and 3 ms on the wrist case.
- **Counts:** user-mode instructions and cycles per decode come from `perf stat` over 60 decodes, and include process start-up and reading the file.
- **Load:** the load average was 19–20 from other agents throughout, so only the instruction counts are reliable; cycles and times are indicative.

| Case | Scale | Full decode + box: instructions / cycles / min time | Scaled decode: instructions / cycles / min time | Instruction ratio |
|---|---|---|---|---|
| `gen-bench-photo-rgb8-2048-ijg-baseline` (2048×2048, 8-bit YCbCr 4:2:2) | 1/8 | 176M / 72M / 16.8 ms | 57M / 29M / 6.4 ms | 3.1× |
| | 1/4 | 209M / 111M / 20.5 ms | 86M / 35M / 8.4 ms | 2.4× |
| | 1/2 | 318M / 133M / 30.4 ms | 97M / 50M / 10.5 ms | 3.3× |
| `local-wrist-lateral` (2320×2920, 12-bit mono) | 1/8 | 169M / 81M / 22.1 ms | 93M / 55M / 12.5 ms | 1.8× |
| | 1/4 | 197M / 109M / 27.9 ms | 129M / 69M / 15.3 ms | 1.5× |
| | 1/2 | 297M / 134M / 29.8 ms | 131M / 66M / 17.4 ms | 2.3× |

Full decode alone, without the downsample, costs 134M instructions on the colour case and 143M on the wrist. The box downsample in this example costs more at 1/2 than at 1/8, because its per-block sums are short and strided. A better 2× downsample would narrow the 1/2 ratios, but the 1/8 ratios would barely move.

**Where the time goes:**

- **1/8.** Entropy decoding must still read every coefficient to find the next block, so it sets the floor: about 70% of the 12-bit 1/8 decode (`perf record`).
  - The IDCT is one multiply per block.
  - With every component on 1×1 blocks, `decode_block` is compiled in a DC-only form that decodes AC symbols without storing them.
  - The 12-bit radiograph gains less than the colour image for two reasons: its codestream is larger relative to the pixel count (1.73 MB for 6.8 Mpixel, against 0.54 MB for 4.2 Mpixel), and its full decode has no colour stage to save.
- **4:2:2 colour.** At 1/2 and 1/4 the chroma components use the next larger IDCT (8×8 and 4×4) with fancy h2v1 upsampling at the reduced size. At 1/8 they use 1×1 blocks with replicated upsampling. libjpeg-turbo chooses the same.
- **Reduced IDCT kernels.** The 4×4 (1/2) and 2×2 (1/4) transforms have AVX2 and wasm simd128 kernels (`simd.rs`). They are needed: the scalar `jidctred.c` port made the 1/2 decode cost more instructions than full decode plus box (219M against 169M on the wrist), because the full path's 8×8 IDCT is vectorised.
  - Lanes are columns in pass 1. The 4×4 pass 2 runs on the transposed work array.
  - The 2×2 pass 2 stays scalar in 64 bits, because for 12-bit data its range limit reads bit 32 of the sum.
  - The kernels are exact for dequantised coefficients within ±25,000 (`idct::REDUCED_MAX`, bound proved by `tests::reduced_bound_holds`). Other blocks take the scalar code.
  - Unit tests compare the kernels with the scalar code on random blocks. `scaled/check_wasm.mjs` compares the base and simd128 wasm builds with the native build on every corpus frame at every scale: 810 comparisons, all equal.
  - Wasm timing is not measured here.
