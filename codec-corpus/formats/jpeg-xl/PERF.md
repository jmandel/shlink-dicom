# jpeg-xl performance

How fast `shl-jpegxl` decodes, compared with libjxl 0.12.0, and what changed to get there. This is track T6 of [docs/PERF-PLAN.md](../../../docs/PERF-PLAN.md#t6-jpeg-xl-lossy).

## How it is measured

These numbers come from two scratch harnesses that decode bare codestreams (the DICOM wrapper adds a copy and the integer conversion). `codecs/bench/run.mjs` now has JPEG XL cases too (the photo and DX bench seeds and a real IDC radiograph; see the bench README), with libjxl as the native and wasm reference, for the plan's quiet full runs:

- **wasm:** each build and libjxl run in their own dedicated worker in headless Chromium 154, interleaved per file; fastest of 9 decodes after one warm-up. libjxl is 0.12.0 built with emscripten 6.0.12 and `-msimd128`, single-threaded, asked for float output for lossy images and 8- or 16-bit integers for lossless ones (what `shl-jpegxl` returns).
- **native:** fastest of 7 decodes, and `perf stat` instruction counts; libjxl through its decode API with no parallel runner, same output formats.
- **Files:** encodes of local test images, made with cjxl 0.12.0. Lossy at distance 1: a 2048² photograph, a 2542×3054 hand X-ray (12-bit grey), a 2048² digital X-ray (12-bit grey), a 1024×650 slide region and a 512² CT (16-bit grey); the photograph also at distance 3. Lossless at effort 1, 3 and 7 of the same images.
- **Load:** the machine is shared; every table gives the load average. Each change was also checked by instruction count, which holds up under load.
- **Fuzz:** 10 minutes of the `decode` target (4 processes, load average 3.5–5.6) after the entropy change: 1,450,735 inputs, no crashes, timeouts or out-of-memory.
- **Correctness:** every change gives bit-identical output. Checked on the wasm build by hashing every decoded sample of all bench, corpus and conformance files against the previous build; through the DICOM CLI by hashing the 40 jpeg-xl corpus cases at full size and at scales 1–3 (identical to main; the other hash sets of the plan hold no JPEG XL); natively by the lossless comparison with djxl (52 files, byte-identical), the lossy comparison (unchanged histogram), JPEG reconstruction (44 files, byte-identical), the 40 conformance cases (identical numbers) and `check.py` (40/40).

## Results

Times in ms, fastest of 9 (wasm) or 7 (native) decodes. "main" is the code before this track (8bfe6b2), "perf-t6" the first group of changes (0feca06), "now" adds the EPF block skip. Load average 3–4.5 for both runs, with another agent's benchmark running at the same time.

**wasm** (Chromium 154, simd128, one worker each):

| File | main | perf-t6 | now | libjxl | now ÷ libjxl |
|---|---|---|---|---|---|
| Photo 2048², d1 | 231.9 | 184.1 | 178.9 | 142.4 | 1.26 |
| Hand X-ray 2542×3054, d1 | 381.3 | 296.8 | 282.8 | 235.8 | 1.20 |
| DX 2048², d1 | 191.5 | 154.7 | 139.7 | 118.4 | 1.18 |
| Slide 1024×650, d1 | 34.7 | 27.2 | 25.2 | 22.0 | 1.15 |
| CT 512², d1 | 11.6 | 9.1 | 8.8 | 8.1 | 1.09 |
| Photo 2048², d3 | 251.3 | 203.2 | 158.8 | 118.9 | 1.34 |
| Photo 2048², lossless e1 | 196.7 | 150.9 | 152.7 | 134.4 | 1.14 |
| Hand X-ray, lossless e1 | 120.0 | 95.9 | 96.0 | 81.9 | 1.17 |
| DX 2048², lossless e1 | 62.9 | 46.7 | 47.2 | 40.3 | 1.17 |
| Slide, lossless e1 | 25.4 | 16.1 | 16.4 | 16.7 | 0.98 |
| Hand X-ray, lossless e7 | 691.6 | 698.1 | 702.8 | 686.0 | 1.02 |

**native** (x86-64; libjxl uses AVX2, we use SSE2 through auto-vectorisation):

| File | main | perf-t6 | now | libjxl 1 thread | now ÷ libjxl | libjxl 4 threads | libjxl 12 threads |
|---|---|---|---|---|---|---|---|
| Photo 2048², d1 | 160.9 | 153.9 | 150.7 | 79.1 | 1.91 | 35.1 | 27.0 |
| Hand X-ray 2542×3054, d1 | 269.1 | 250.3 | 246.2 | 116.0 | 2.12 | 42.3 | 26.7 |
| DX 2048², d1 | 132.0 | 125.0 | 118.9 | 57.4 | 2.07 | 23.3 | 18.4 |
| Slide 1024×650, d1 | 23.7 | 23.6 | 22.5 | 12.8 | 1.76 | 6.2 | 5.2 |
| CT 512², d1 | 7.7 | 7.7 | 7.3 | 3.6 | 2.03 | 2.1 | 2.1 |
| Photo 2048², d3 | 170.7 | 170.1 | 140.7 | 60.9 | 2.31 | 29.0 | 24.0 |
| Photo 2048², lossless e1 | 153.9 | 132.5 | 131.1 | 107.2 | 1.22 | 34.8 | 17.4 |
| Hand X-ray, lossless e1 | 93.3 | 78.8 | 79.4 | 65.9 | 1.20 | 21.0 | 10.0 |
| DX 2048², lossless e1 | 47.1 | 39.0 | 38.9 | 33.0 | 1.18 | 10.5 | 5.3 |
| Slide, lossless e1 | 18.4 | 14.8 | 14.5 | 13.8 | 1.05 | 4.5 | 2.4 |
| Hand X-ray, lossless e7 | 648.3 | 646.2 | 645.3 | 817.9 | 0.79 | 213.8 | 111.3 |

`shl-jpegxl` decodes one image on one thread; the viewer decodes several frames at once in its worker pool.

**Size:** the JPEG XL code in the stripped wasm grows by 4.7 KB (2.7 KB gzip) over main.

## What changed

The crate stays `#![forbid(unsafe_code)]` and has no new dependencies.

Each effect was measured on its own during the work (on the scratch branch, against the build before it; wasm, the five distance-1 files, fastest of 9, load 3–6).

| Change | Effect (wasm) |
|---|---|
| **`F4`, four f32 lanes** (`src/simd.rs`). In wasm with simd128 each operation is one v128 instruction. Loads and stores go through fixed-size array lanes (`f32x4(a[0], a[1], a[2], a[3])` from a `&[f32; 4]`), which LLVM turns into `v128.load`/`v128.store`, so no unsafe is needed. Elsewhere it is a plain array. A test checks each lane operation against the scalar one. | the building block |
| **EPF** in `F4` lanes, over the row width rounded up to a multiple of 4 (row buffers carry the slack, extra lanes are never stored). LLVM had vectorised only the simplest of its loops. | −9.4% on the lossy files |
| **Dequantisation** in `F4` lanes: the bias adjustment's three cases are computed for four coefficients and selected, instead of a branch and a division per coefficient. | −10.5% |
| **IDCT transposes** in 4×4 lane blocks, checked against the scalar transpose by a test. | −1% |
| **LLF resample scales** tabulated once per size instead of three cosines per coefficient. | −0.3% |
| **EPF skips 8×8 blocks** whose sigma is below the minimum (they keep their input; libjxl skips them too). Each row's filtered column ranges are collected once. | −3% to −10% at distance 1, −22% at distance 3 (three EPF passes); natively −2% to −11% instructions, −26% at d3 |
| **RLE-only lossless streams** (effort 1): libjxl's fastest encoder writes prefix codes whose only LZ77 distance is the previous value. For a gradient channel with one context, the tables are now resolved once and a run repeats the previous token without the LZ77 window, as libjxl's "Gradient RLE" track does. | −25% to −35% on effort-1 files; natively −28% to −37% instructions |

## Rejected

| Attempt | Result |
|---|---|
| `F4` lanes for Gaborish, XYB→RGB, the sRGB curve and the 8×8 IDCT columns | no change: LLVM already vectorised these loops |
| Auto-vectorisation-friendly rewrites of EPF (exact-length reslicing, zipped iterators) | no change |
| EPF as one pass per row, accumulating every offset in registers (as libjxl does) | 3.6% slower in wasm: every load needs its own bounds check |
| EPF in 64-column blocks with the slices cut per block, skipping blocks whose sigma is below the minimum | 3.4% faster in wasm than the per-offset loops, but about 60% slower natively, and a second EPF implementation for one target would break the one-implementation rule |
| relaxed-simd FMA on the five multiply-add sites | 1.4% faster, not bit-exact, Chromium only |
| AVX2 + FMA kernels (`#[target_feature]`) for three EPF loops | −4.5% natively, needs an `unsafe` dispatch call per kernel; deferred (native only) |
| The whole crate built for x86-64-v3 (an upper bound for AVX2 auto-vectorisation) | −1% natively |
| Resolving the AC entropy tables once per group (ANS without LZ77) | 0.2–2.9% more instructions natively: the per-call dispatch cost more than the lookups it saved |
| IDCT bundles of 4 lanes instead of 8 (to cut register spills natively) | 5% more instructions natively; in wasm within noise, +4% on DX |
| One copy fewer in the 2-D IDCT (the second pass works in the scratch block) | −0.5% instructions; in wasm under 1% |
| Threads within one image (groups, EPF, Gaborish, colour) | 1.5× at 4 threads, 1.7× at 8 in a rough prototype; deferred (the viewer decodes frames in parallel already) |

## Where we stand

The track stopped (16 Oct 2026) after three changes in a row saved less than 3% (the last three rows of the rejected table).

- **wasm, lossy:** 1.09–1.26× libjxl's time at distance 1 and 1.34× at distance 3, down from 1.4–2.1×. In the last wasm profile (before the EPF skip), the IDCT took about a quarter of the time, the EPF about a fifth, AC entropy decoding about an eighth and the output transfer curve about a tenth (libjxl's curve costs it about as much).
- **wasm, lossless:** level with libjxl at effort 7, 1.14–1.17× at effort 1 (0.98 on the slide).
- **native:** 1.8–2.3× libjxl single-threaded on lossy files (libjxl uses AVX2 and FMA), 1.05–1.22× at effort 1, 0.79× at effort 7. libjxl's threads take it to 4–9× our time at 12 threads.
- **Next idea, not done:** an IDCT that keeps each transform's data in registers across the butterfly stages instead of copying arrays at every recursion level, as libjxl's does. It would be a rewrite of the IDCT, not a change to it, and the two cheaper attempts at the same cost (4-lane bundles, one copy fewer) moved less than the noise; AVX2 and threads, the larger native gains, are deferred by the plan.
