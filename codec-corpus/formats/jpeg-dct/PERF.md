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
- **Native builds:** release profile. AVX2 kernels are chosen at run time. The tables below were measured on builds for the baseline x86-64 target; native builds now target x86-64-v3 ([CPU requirement](../../../codecs/README.md#cpu-requirement)).
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

"Now" and the references come from the quiet run `quiet-full3` of 16 October 2026 (load average 1.2 when it started, the other agents idle), built from main at db16333; "Original" is the first measurement of the original decoder. The values are the minimum ms per frame over the passes.

**Native.** Every reference decoder decodes from memory except `dcmdjpeg`, which runs as a separate process with DICOM file I/O.

| Case | Original | Now | Speed-up | libjpeg-turbo 3.2 (tj3) | libjpeg-turbo (Pillow) | pylibjpeg | dcmdjpeg |
|---|---|---|---|---|---|---|---|
| colour 640×480 | 4.96 | 0.89 | 5.6× | 0.82 | 0.86 | 7.70 | 3.15 |
| photo 2048² colour | 58.4 | 14.0 | 4.2× | 11.8 | 14.3 | 103.7 | 57.8 |
| wrist 2320×2920 12-bit | 54.8 | 18.9 | 2.9× | 31.5 | n/a | 121.1 | 70.9 |
| dx2048 12-bit DCT | 39.7 | 14.7 | 2.7× | 22.6 | n/a | 86.3 | 58.4 |
| dx2048 lossless | 73.9 | 15.5 | 4.8× | 23.9 | n/a | 155.4 | 60.7 |
| ct512 16-bit lossless | 4.22 | 1.16 | 3.6× | 1.49 | n/a | 8.66 | 18.4 |

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

**Against libjpeg-turbo in wasm.** In the same quiet window, `codecs/bench/run.mjs` timed our wasm simd128 codec stage and `@cornerstonejs/codec-libjpeg-turbo-8bit` 1.2.8 (`decode()` only) in one Chromium 154 worker. Ours takes 0.46–0.56× its time on 8-bit colour (cine, color3d, the mirax slide tiles and the 2048² photo) and 0.45× on the 8-bit lossless GE series. That package decodes only 8-bit images; on 12-bit DCT and lossless frames our wasm build takes 0.63–0.84× the time of native libjpeg-turbo.

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
  - The extra-bit mask of each category in the code table, removing a shift, a mask and a select per sample: 11% fewer native and 5% fewer wasm instructions, but only 1.7% fewer native cycles and about 2% fewer in wasm.
- **Stopped:** the encoder is 4.6–5.4× faster than libjpeg-turbo on these series, and the last ideas each saved under 3% of cycles. In the wasm transcode the encoder is now about 40% and the self-check's SV1 decode about a third, so further gains there are decoder work ([SV1 on real CT series](#sv1-on-real-ct-series)).
- **Exactness:** SV1 outputs of every live file (735 encoded, 4 declined, as before) and every corpus file are byte-identical to the previous build natively, and the wasm build's outputs equal the native ones.

## Track T4: 8-bit colour

[Performance plan, T4](../../../docs/PERF-PLAN.md#t4-jpeg-baseline-8-bit-colour). Real frames: `pydicom-color3d_jpeg_baseline` (ultrasound cine, 120 frames of 640×480 YCbCr 4:2:2) and `idc-jpgbase-ybr422-u8of8-p0-mf-sm-mirax-6fc896a9` (8 slide tiles). References on the same codestreams: libjpeg-turbo 3.2 natively (`tj3Decompress8` from Python, as `perf_refs.py`) and the Cornerstone libjpeg-turbo 8-bit wasm build in Node (`decode()` only, fastest of 7 passes).

| Case | Native: ours / libjpeg-turbo, ms per frame | wasm in Node: ours before → after / libjpeg-turbo wasm, ms per frame |
|---|---|---|
| ultrasound cine | 0.90 / 0.82 | 1.50 → 1.38 / 2.88 |
| slide tiles | 2.82 / 2.65 | 5.07 → 5.01 / 9.53 |

(Ours in wasm: codec-stage medians from the bench module; load 2–5.)

- **YCbCr → RGB in wasm on 16-bit lanes.** The simd128 colour kernel widened everything to 32-bit lanes and multiplied with `i32x4.mul`. Each term (k·x + 2^15) >> 16 is now j·x + ((k'·x + 2^15) >> 16) with k = j·2^16 + k' and |k'| < 2^15, so the products become `i32x4.dot_i16x8_s` of (x, 2)·(k', 2^14) pairs and everything else stays in 16-bit lanes (identity checked for every 8-bit chroma pair by `ycc_terms_regrouped_for_16_bit_lanes`). Cycles per decode in Node, minimum of 4 rounds: cine 766M → 689M (−10%), slide tiles 170M → 158M (−7%). Outputs identical: corpus and live JPEG (481 files) and the long tail's 190 baseline files, against the previous wasm build.

Rejected:

- **An explicit native AVX2 colour kernel** (`pmaddwd` on the same 16-bit regrouping, `pshufb` to interleave RGB, no new `unsafe`). Cycles: cine −2.2 to −2.7%, slide tiles about −3% within noise; instructions +8%. LLVM already vectorises the scalar loop well with AVX2, so the gain is under the 3% bar.
- **4:2:2 upsampling fused with colour conversion in wasm.** One simd128 pass computed `h2v1_fancy` of both chroma rows in registers and fed them straight to the colour kernel, with no scratch rows. Instructions −4% (cine 2,158M → 2,071M, slide tiles 486M → 463M) but cycles +3% on cine (679M → 698M) and +1.4% on the slide tiles (157M → 159M), minimum of 4 rounds in Node. The scratch rows stay in L1, so writing and reading them again costs little; the longer kernel with six live chroma vectors per step ran slower in V8. Outputs were identical (481 corpus and live files, 190 long-tail files).
- **A cheaper RGB interleave in wasm.** V8 lowers each general two-input `i8x16.shuffle` to two `pshufb` and a `por`, and rebuilds both masks from 64-bit immediates in every iteration; the current interleave has six such shuffles per 16 pixels. A probe build that stored the three planes without interleaving them (wrong output, measurement only) showed what the interleave can cost at most: 3.6% of cine cycles and 3–10% of the slide tiles' across three runs at load 2–5. Rewriting it as byte and 16-bit unpacks plus a 3-of-4-byte compress, with overlapping stores, did not survive LLVM: it merged the unpacks and the compress back into two-input shuffles. With the compress as a `u8x16_swizzle` to stop that, cycles did not move (slide tiles 156.5M → 159.0M, cine within 1%). Outputs were identical.

**T4 stops here**: three changes in a row were rejected. The remaining gap is native, where cine takes 1.10× and slide tiles 1.13× libjpeg-turbo's time in the [quiet run](#final-comparison). In wasm we already take 0.46–0.56× the time of the libjpeg-turbo build. The next idea is streaming rows to the colour pass after each MCU row while the planes are still in cache. It was not written: a 640×480 frame's planes take about 600 KB, and the colour pass runs at its average IPC, so it is not waiting on memory.

## Track T8: no unsafe kernels

[Performance plan, T8](../../../docs/PERF-PLAN.md#t8-removing-unsafe). The SIMD kernels no longer use `unsafe`. The crate's one `unsafe` call enters a single `#[target_feature(enable = "avx2")]` function after `is_x86_feature_detected!("avx2")`. That function builds the AVX2 kernel set from closures, which inherit its target feature and so call the kernels as safe code, and runs the frame decode with it. The decode is the same generic code as the scalar path, which calls the kernels through those closures' `fn` pointers (see `simd.rs`).

- **wasm simd128:** loads and stores go through slices. 8-bit samples move as 64-bit integers, which LLVM turns into `v128.load64_zero` and vector stores; 16-bit samples use lane constructors and extracts. The wasm instruction counts are unchanged within 0.2% on cine, slide tiles, the 2048² photo and the wrist (Node, `--no-liftoff`), and within 1.9% on an RGB 4:4:4 live slide, where `rgb_row8` is no longer inlined. Cycles were within run-to-run noise (load 2–3).
- **Native AVX2:** the kernels are `#[target_feature]` functions that call the intrinsics directly (target_feature 1.1). A trait method cannot enable AVX2, so the `Lane` type for the shared 1-D transforms is an `[i32; 8]` with wrapping arithmetic, which LLVM compiles to the same `vpaddd`/`vpmulld`. Block loads and stores go through arrays and slices, and one bound on `stride` up front lets LLVM drop the per-row checks. Cycles against the previous build (minimum of 6 alternating rounds, `perf stat`, load 2.5–3): photo +1.7%, wrist 12-bit +2.5%, slide tiles +0.4%, cine +0.2%, dx2048 12-bit +0.7%; instructions +0.5–1.4%. The cost is LLVM no longer folding the last transpose into the packs, plus a few extra adds. For scale, libjpeg-turbo 3.2 (tj3) takes 0.82 ms per cine frame, 2.65 ms per slide tile and 11.8 ms for the photo in the same window, against our 0.89, 2.88 and 14.9 ms.
- **Outputs:** identical natively on the corpus at every scale, the live sample, the long tail and the SOP sweep (all JPEG XL differences are the same on main). In wasm they are identical on the 481 corpus and live files and the 190 long-tail baseline files. The AVX2-against-scalar corpus test passes on 2,949 frames.
- **One entry instead of three dispatch calls:** cycles against the previous build, minimum of 6 alternating rounds at load 3–5. Built for x86-64-v3: cine −1.2%, slide tiles −0.5%, photo 0%, wrist −0.3%, dx2048 12-bit +0.3%, dx2048 SV1 +1.3%. Built for the baseline x86-64 target: −1.1%, −1.6%, +0.8%, +3.5%, +1.5% and −1.7%. Instructions +0.1–0.5%, from the indirect calls. Built for x86-64-v3, ours takes 0.87 ms per cine frame, 2.75 ms per slide tile and 13.6 ms for the photo; libjpeg-turbo 3.2 (tj3) in the same window takes 0.81, 2.62 and 11.7 ms. Outputs were identical on the same sets as above, natively and through the wasm viewer module at every scale.
