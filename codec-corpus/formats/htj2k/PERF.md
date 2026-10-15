# HTJ2K decode speed

The budget is 150 ms to decode a 512×512 16-bit frame in wasm32. The as-released `oxideav-jpeg2000` 0.0.17 took 621 ms. With two patches to a vendored copy it takes **30 ms**, and every corpus case still decodes exactly. The patches are in [FORMAT.md, Phase 2c](FORMAT.md#phase-2c-speed) and the [vendor README](../../../codecs/shl-codec-htj2k/vendor/README.md).

## How it was measured

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

## Steps

512×512 16-bit lossless, in ms:

| Step | Change | native | wasm32 | Corpus |
|---|---|---|---|---|
| 0 | crates.io 0.0.17 | 290 | 621 | 38/38 |
| A1 | patch 1: `Nb(u, v)` resolved once per code-block | 68 | 96 | 38/38 |
| A2 | patch 2: CxtVLC lookup index | 22 | 30 | 38/38, then 40/40 with the MIXED cases |

The A1 figures come from one run in the same session; the others are the final repeated runs. A profile after A1 put 70% of the time in `decode_cxt_vlc`, 11% in the 1-D 5/3 DWT and 8% in MagSgn decoding.

## Final timings

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

## Exactness

- **Corpus:** after each step, check.py on `htj2k` and `jpeg2000` passed 100%: htj2k 38/38 (then 40/40) and jpeg2000 166/166.
- **Differential check:** 2,320 inputs were decoded with both crates.io 0.0.17 and the patched copy, and compared on samples and on the error returned. The inputs were 400 corpus frames from both formats, plus the HTJ2K fuzz corpus of mutated frames. 826 decoded to identical samples, 1,494 gave the identical error, and none differed.
- **Unit tests:** oxideav's own unit tests pass (839), plus a new test checking the CxtVLC index against the linear search for every input. Upstream's integration tests at the `v0.0.17` tag also pass with the patched sources, including the MIXED conformance test.
