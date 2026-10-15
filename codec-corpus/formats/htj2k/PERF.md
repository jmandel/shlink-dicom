# HTJ2K decode speed

Two rounds:
- **Phase 2c** made the 512×512 16-bit frame decode in 30 ms in wasm32, against a 150 ms budget (oxideav took 621 ms as released).
- **Phase 2d** moved HT decoding into the vendored hayro. Native decoding is now 2–3.8× OpenJPH's time, and wasm-simd 2.5–4.6×. JPEG 2000 averages 1.20× OpenJPEG natively.

Every HTJ2K and JPEG 2000 corpus case still decodes exactly. (One JPEG 2000 case that should be refused now decodes; this is caused by a change in the shared CLI, not in the codecs; see FORMAT.md STATUS.) The patches are listed in FORMAT.md ([Phase 2c](FORMAT.md#phase-2c-speed), [Phase 2d](FORMAT.md#phase-2d-ht-decoding-in-hayro)) and in the vendor READMEs ([oxideav](../../../codecs/shl-codec-htj2k/vendor/README.md), [hayro](../../../codecs/shl-codec-jpeg2000/vendor/README.md)).

## Phase 2c: oxideav patches

The budget is 150 ms to decode a 512×512 16-bit frame in wasm32. The as-released `oxideav-jpeg2000` 0.0.17 took 621 ms. With two patches to a vendored copy it takes **30 ms**, and every corpus case still decodes exactly.

### How it was measured

- **Frames:** `../jpeg2000/extra/bench_frames.py OUT_DIR` writes the frames, with a JSON FrameInfo beside each one:
  - synthetic smooth-plus-noise 16-bit frames encoded lossless by `ojph_compress`;
  - the corpus 640×480 RGB HTJ2K frame (`HTJ2KLossless_08_RGB`);
  - the same images as JPEG 2000, for hayro.

  One extra frame is the 512×512 synthetic frame encoded lossy by `ojph_compress -qstep 0.001`, to time the 9/7 path.
- **Harness:** `codecs/shl-codec-htj2k/bench`, a separate crate outside the workspace (a copy of the jpeg2000 one). It has two parts:
  - `shl-htj2k-bench DIR` is the native timer;
  - `bench.mjs` times the wasm32 cdylib in node 24.

  Both build with `lto = true` and `codegen-units = 1`, with rustup stable 1.97. The wasm build has no `simd128`. Each figure is the median of 7 decodes (3 for the 2048² frame) through `decode_frame`, so it includes the header checks and output packing.
- **Repeats:** for the final table, the baseline and patched builds were run one after the other, three times each, in the same session. The table gives the median of the three medians. The three runs never differed by more than 4%, except one native 2048² run at +8%. The load average was 1–2 on 12 cores.

### Steps

512×512 16-bit lossless, in ms:

| Step | Change | native | wasm32 | Corpus |
|---|---|---|---|---|
| 0 | crates.io 0.0.17 | 290 | 621 | 38/38 |
| A1 | patch 1: `Nb(u, v)` resolved once per code-block | 68 | 96 | 38/38 |
| A2 | patch 2: CxtVLC lookup index | 22 | 30 | 38/38, then 40/40 with the MIXED cases |

The A1 figures come from one run in the same session; the others are the final repeated runs. A profile after A1 put 70% of the time in `decode_cxt_vlc`, 11% in the 1-D 5/3 DWT and 8% in MagSgn decoding.

### Final timings

HTJ2K through `shl-codec-htj2k`, in ms:

| Frame | before, native | after, native | before, wasm32 | after, wasm32 | speed-up (wasm32) |
|---|---|---|---|---|---|
| 512×512 16-bit lossless | 290 | 22 | 621 | **30** | 21× |
| 512×512 16-bit lossy (9/7) | 299 | 22 | 627 | 29 | 22× |
| 640×480 RGB (`HTJ2KLossless_08_RGB`) | 968 | 75 | 2,053 | 86 | 24× |
| 2048×2048 16-bit lossless (7.1 MB) | 4,781 | 435 | 10,113 | 540 | 19× |

These are now faster than hayro on the same images coded as JPEG 2000: 63 ms, 48 ms and 995 ms in wasm32. Lossless HT coding is cheaper to decode than MQ coding.

**JPEG 2000 (.90/.91) through `shl-codec-jpeg2000` (hayro) did not change.** The two builds were within 1% of each other: 62.5 / 62.5 ms for 512² 16-bit, 48.4 / 48.7 ms for 640×480 RGB and 993 / 995 ms for 2048², in wasm32. That crate's code is unchanged.

Part 1 code-blocks inside an HTJ2K file (allowed by the MIXED set, and by `.201`–`.203` files without HT blocks) still go through oxideav's MQ decoder. Patch 1 also made that path 4–6× faster: on the JPEG 2000 versions of the frames, wasm32 times went from 685 to 166 ms (512²), 1,427 to 240 ms (RGB) and 11,165 to 2,679 ms (2048²). That is still 2.7–4.9× slower than hayro, but such frames are rare in HTJ2K files.

### Exactness

- **Corpus:** after each step, check.py on `htj2k` and `jpeg2000` passed 100%: htj2k 38/38 (then 40/40) and jpeg2000 166/166.
- **Differential check:** 2,320 inputs were decoded with both crates.io 0.0.17 and the patched copy, and compared on samples and on the error returned. The inputs were 400 corpus frames from both formats, plus the HTJ2K fuzz corpus of mutated frames. 826 decoded to identical samples, 1,494 gave the identical error, and none differed.
- **Unit tests:** oxideav's own unit tests pass (839), plus a new test checking the CxtVLC index against the linear search for every input. Upstream's integration tests at the `v0.0.17` tag also pass with the patched sources, including the MIXED conformance test.

## Phase 2d: HT decoding in hayro

The second goal was:
- HTJ2K within about 3× of OpenJPH (the 2048² 12-bit lossless frame decodes in 13.3 ms with OpenJPH on a quiet machine);
- JPEG 2000 within about 1.2× of OpenJPEG.

FORMAT.md, [Phase 2d](FORMAT.md#phase-2d-ht-decoding-in-hayro), describes the change: HT code-blocks decoded inside the vendored hayro, plus speed work in hayro and in `shl-codec-jpeg2000`.

### How it was measured

The machine was heavily loaded throughout, with a load average of 13–27 on 12 cores while other agents ran. Separate benchmark runs disagreed by up to 3×. So three measurements are reported, from the most to the least robust:
1. **User-mode instructions and cycles per decode** (`perf stat`), for the steps. Instruction counts do not depend on load; cycle counts do somewhat, but much less than wall time.
2. **Paired ratios against the C library** (`ratio.py`, kept outside the tree). It times our decode, then the reference, alternately, seven times, and takes the median of each. Both see the same load. Ours is the median of five decodes of the frame through `decode_frame`:
   - natively, the `shl-codec-htj2k/bench` binary;
   - in wasm32, the same crate built with `+simd128` and run in node 24.

   The reference is OpenJPH through imagecodecs, or OpenJPEG through pylibjpeg-openjpeg, called from Python on the codestream.
3. **The shared benchmark,** `node codecs/bench/run.mjs --format htj2k --format jpeg2000 --runners native,chromium-worker,ref --builds simd`. Its runners execute one after another, so under changing load its ratios are the least reliable of the three.

### Steps

DX 2048² 12-bit lossless (`gen-bench-dx2048-u12-openjph-rev`), native, per decode. Cycles are medians of three alternating runs of all the builds back to back. The first row is the end of phase 2c (oxideav, measured separately).

| Build | Change | M instructions | M cycles |
|---|---|---|---|
| oxideav (phase 2c) | | 2,979 | ~1,770 |
| hayro HT path | HT blocks in hayro; `pack_rows` with branch-free exact rounding | 704 | 403 |
| + floor | exact floor without libm's `floorf` (patch 6) | 649 | 288 |
| + rounding | `round_clamped`: vectorisable rounding in `pack_rows` | 582 | 255 |
| + IDWT rows | interleave and horizontal lifting fused and vectorised (patch 7) | 498 | 186–218 |
| + reader | forward reader refill fast path | 483 | |
| + MagSgn | MagSgn bit buffer in local variables | 448 | 211 |
| + level shift | DC level shift added while storing (patch 8) | 450 | 199 |
| + MagSgn rows | MagSgn rows written through slices | 425 | 188 |
| + no copy | single tile: IDWT output becomes the image buffer (patch 8) | 425 | 155–182 |
| + vertical | vertical lifting in one pass (patch 9) | 426 | about the same |
| + VLC | VLC bit buffer in local variables | 426 | 177 |
| + deferred shift | DC level shift added in the final conversion (patch 8) | 422 | 160 |
| + VLC reader | backward reader refill fast path (final) | 409 | 158 |

In all, 7.3× fewer instructions and about 11× fewer cycles than oxideav. Changes that measured as no faster were dropped: decoding MagSgn samples in pairs, and inlining the reader's slow path.

Each hayro step was checked as follows:
- every JPEG 2000 and HTJ2K corpus frame (2,569 and 79) was decoded before and after, and the outputs compared by hash: all identical;
- check.py stayed at 100% (before the CLI change described in FORMAT.md STATUS);
- the HT block decoder's round-trip tests passed.

### Final results

**HTJ2K, paired with OpenJPH** (load average 18–19; ms):

| Frame | native | OpenJPH | ratio | wasm-simd (node) | OpenJPH | ratio |
|---|---|---|---|---|---|---|
| DX 2048² 12-bit lossless | 53.4 | 16.3 | 3.3× | 71.2 | 19.1 | 3.7× |
| DX 2048² 12-bit lossy | 41.9 | 14.6 | 2.9× | 59.1 | 15.4 | 3.9× |
| CT 512² 16-bit lossless | 4.3 | 1.1 | 3.8× | 3.9 | 0.8 | 4.6× |
| RGB 2048² lossy | 167 | 85.1 | 2.0× | 154 | 62.0 | 2.5× |

Repeated pairings of the 2048² lossless frame gave native ratios between 2.0× and 3.3× as the load changed (the shared benchmark's run gave 2.0×). The wasm build is about 1.3× slower than native.

**HTJ2K, the shared benchmark** (r2-before at load 2.7, r2-final at load 17; ms):

| Case | native before | native after | wasm-simd before | wasm-simd after | OpenJPH (same run) | native ÷ OpenJPH |
|---|---|---|---|---|---|---|
| CT 512² u16 lossless | 18.1 | 1.86 | 22.1 | 9.48 | 1.15 | 1.6× |
| DX 2048² u12 lossless | 384 | 40.8 | 458 | 132 | 19.3 | 2.0× |
| DX 2048² u12 lossy | 337 | 36.2 | 329 | 116 | 15.5 | 2.2× |
| RGB 2048² lossy | 1,165 | 143 | 1,226 | 354 | 83.5 | 1.7× |
| RGB cine 640×480×30 lossless | 1,336 | 174 | 1,751 | 394 | 100 | 1.7× |
| CT 512² s16 lossless | 20.0 | 2.09 | 25.6 | 4.80 | 0.97 | 2.1× |
| RGB 640×480 lossless | 70.4 | 8.24 | 85.6 | 18.5 | 4.63 | 1.8× |

The Chromium column of the final run is 2–5× slower than native, while node ran the same wasm about 1.3× slower than native minutes later. The final run's Chromium figures are probably inflated by load; the paired node figures above are the better estimate.

**JPEG 2000, paired with OpenJPEG** (load average 18–20; ratios):

| Frame | native | wasm-simd (node) |
|---|---|---|
| CT 128² s16 lossless | 1.15× | 1.74× |
| CT 512² u16 lossless | 1.44× | 1.37× |
| CT 512² u16 lossy | 1.13× | 1.30× |
| DX 2048² u12 lossless | 1.18× | 1.28× |
| DX 2048² u12 lossy | 1.30× | 1.16× |
| RGB 2048² lossy | 1.02× | 1.10× |
| RGB cine 640×480 lossless (one frame) | 1.32× | 1.49× |
| 2048×2500 12-bit (Kakadu) | 1.18× | 1.41× |
| RGB 2670×3340 lossy (`VL5_J2KI`) | 1.03× | 1.30× |
| Slide tile 256² (IDC) | 1.34× | 1.16× |
| geometric mean | **1.20×** | **1.32×** |

At the start of the round, the shared benchmark put hayro at 1.4–2× OpenJPEG. Lossless JPEG 2000 is 94% MQ/EBCOT tier-1, which this round did not change; the gains came from the stages after tier-1 (wavelet, level shift, copies, conversion). The shared benchmark's own before/after deltas for JPEG 2000 range from −40% to +44% under the changing load, so they are not quoted here. The rest of the gap to OpenJPEG on lossless frames is in tier-1.

### What is left

- **The HT block decoder** is 55–60% of an HTJ2K decode, about 20 cycles per sample. It is scalar; OpenJPH decodes MagSgn with SIMD (SSSE3, AVX2 and wasm SIMD versions). Porting that approach would close most of the remaining gap, in wasm especially. It needs per-lane variable shifts, which fearless_simd does not offer on every target, and `#![forbid(unsafe_code)]` rules out raw intrinsics.
- **MQ tier-1** for lossless JPEG 2000: the code is already tuned; what is visible in profiles is bounds checks on the coefficient arrays (about 5%) and register spills.
- **Streams hayro declines** (MIXED, MULTIHT) still decode through oxideav at phase 2c speed.

## Reduced-resolution decode

`decode_frame_scaled` in `shl-codec-jpeg2000` and `shl-codec-htj2k` decodes at 1/2^s by discarding the s highest resolution levels (vendored hayro patch 10; [jpeg2000 FORMAT.md, Reduced-resolution decode](../jpeg2000/FORMAT.md#reduced-resolution-decode)). Their code-blocks are never decoded. This table compares it with what a thumbnail costs without it: a full decode followed by a box downsample.

**Method:**
- **Machine:** Ryzen 5 3600, native release build.
- **Tool:** `cargo run --release -p shl-codec-htj2k --example scaled_bench -- <frames dir> 20 loop S | loopfull S`, on frame 0.
  - `loop S` runs `decode_frame_scaled`.
  - `loopfull S` runs `decode_frame` followed by a box downsample by 2^S. The downsample loop is the same one used in the jpeg-dct measurement, where at 1/8 it cost about 3 ms for 12-bit mono and 4 ms for RGB at these sizes.
- **Counts:** user-mode instructions and cycles per decode come from `perf stat` over 20 decodes, and include start-up and reading the file.
- **Load:** the load average was 3–6, so the times (minimum of 20) are usable too.

| Case | Scale | Full decode + box: instructions / min time | Reduced decode: instructions / min time | Instruction ratio |
|---|---|---|---|---|
| JPEG 2000 `gen-bench-dx2048-u12-openjpeg-rev` (2048², 12-bit, lossless) | 1/8 | 2,927M / 413 ms | 50M / 7.3 ms | 59× |
| | 1/4 | 2,944M / 417 ms | 177M / 25.7 ms | 17× |
| | 1/2 | 3,006M / 420 ms | 708M / 103 ms | 4.2× |
| JPEG 2000 `gen-bench-dx2048-u12-openjpeg-cr20` (2048², 12-bit, 9/7 at 20:1) | 1/8 | 583M / 70.6 ms | 30M / 4.1 ms | 19× |
| | 1/4 | 600M / 73.2 ms | 70M / 9.8 ms | 8.5× |
| | 1/2 | 662M / 76.4 ms | 186M / 26.1 ms | 3.6× |
| JPEG 2000 `gen-bench-photo-rgb8-2048-openjpeg-cr20` (2048², 8-bit RGB, ICT, 9/7) | 1/8 | 1,530M / 169 ms | 104M / 14.4 ms | 15× |
| | 1/4 | 1,563M / 171 ms | 255M / 33.6 ms | 6.1× |
| | 1/2 | 1,671M / 182 ms | 637M / 113 ms | 2.6× |
| HTJ2K `gen-bench-dx2048-u12-openjph-rev` (2048², 12-bit, lossless) | 1/8 | 421M / 60.0 ms | 9.0M / 1.7 ms | 47× |
| | 1/4 | 439M / 58.1 ms | 28M / 5.8 ms | 16× |
| | 1/2 | 501M / 67.9 ms | 104M / 19.1 ms | 4.8× |
| HTJ2K `gen-bench-photo-rgb8-2048-openjph-q` (2048², 8-bit RGB, 9/7) | 1/8 | 1,179M / 129 ms | 28M / 2.9 ms | 43× |
| | 1/4 | 1,211M / 133 ms | 83M / 9.6 ms | 15× |
| | 1/2 | 1,320M / 145 ms | 297M / 33.7 ms | 4.5× |

Each level discarded removes about three quarters of the remaining code-blocks and of the wavelet synthesis, so the saving compounds. It is largest for lossless JPEG 2000, where MQ tier-1 decoding of the finest levels is almost all of the full decode's cost. At 1/8 a 2048² lossless radiograph costs 7 ms instead of 413 ms. That is less than the 12.5 ms a 1/8 JPEG decode of the 2320×2920 radiograph costs ([jpeg-dct PERF.md](../jpeg-dct/PERF.md#reduced-resolution-decode)), because JPEG must still entropy-decode every coefficient.
