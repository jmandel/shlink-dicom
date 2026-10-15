# jpeg-ls performance

How fast `shl-codec-jpeg-ls` decodes, compared with CharLS, and what changed to get there.

## How it is measured

- **Benchmark:** `node codecs/bench/run.mjs --format jpeg-ls --runners native,chromium-worker --builds simd --label <step>` (see `codecs/bench/README.md`). "native" is our codec stage; "simd" is the whole-file wasm-simd decode in a Chromium worker. The CharLS times are from the full baseline run `2026-10-15-08-57-26-full` (pyjpegls, frame decode only).
- **Between steps:** the machine was shared with other agents (load average 3–26), so wall times were noisy. Each change was judged by one of two methods:
  - `perf stat` cycles and instructions per decode, minimum of 3 runs, on three streams: DX 2048² 12-bit, a 2048² RGB ILV 2 stream, and one cine frame (640×480 RGB ILV 2);
  - an A/B script that alternates the old and new binaries and takes each one's minimum time.
- **Correctness:** checked after every step:
  - `cargo test` (the 69 corpus cases and the 114 extra vectors, all exact);
  - `check.py --format jpeg-ls` at 69/69.

## Results

Times are milliseconds per whole case. "native" is the codec stage, "simd" is the whole-file wasm-simd decode in a Chromium worker, and CharLS is the reference. Neither final benchmark run had a quiet machine. Run `jls-after` (final code) had load average 14–15, and `jls-step3` (the code before the last small bit-reader change) had load average 6. CT 512² shows how noisy they are: 2.44 ms in one run, 3.64 ms in the other.

| Case | CharLS | before native | after native (step3 / final) | ratio to CharLS | before simd | after simd (step3 / final) |
|---|---|---|---|---|---|---|
| CT 128² s16 | 0.37 | 0.79 | 0.30 / 0.45 | 0.81 / 1.22 | 1.16 | 0.71 / 0.79 |
| CT 512² u16 | 2.56 | 4.55 | 2.44 / 3.64 | 0.95 / 1.42 | 5.97 | 3.50 / 2.75 |
| DX 2048² u12 | 62.1 | 109.4 | 65.4 / 65.8 | 1.05 / 1.06 | 142.9 | 76.7 / 76.5 |
| DX 2048² u12 NEAR 3 | 62.9 | 103.5 | 69.8 / 69.7 | 1.11 / 1.11 | 142.0 | 91.4 / 78.1 |
| RGB cine 640×480×30 (ILV 2) | 176.5 | 381.0 | 221.8 / 222.3 | 1.26 / 1.26 | 534.2 | 262.3 / 312.8 |
| CR 1841×1955 15-bit | 102.2 | 133.1 | 88.7 / 82.8 | 0.87 / 0.81 | 167.0 | 97.0 / 117.4 |
| SEG 240²×308 8-bit | 40.2 | 84.7 | 46.4 / 36.1 | 1.15 / 0.90 | 119.1 | 45.9 / 46.2 |
| RGB 768×512 (ILV 2) | 16.5 | 31.7 | 19.9 / 18.0 | 1.21 / 1.09 | 42.5 | 25.7 / 33.2 |
| **Geometric mean, native ÷ CharLS** | | **1.83** | **1.04 / 1.09** | | | |

Before: run `jls-before`, load average 1.2. After: runs `2026-10-15-*-jls-step3` and `2026-10-15-13-00-11-jls-after`.

**Load-robust comparison** (`extra/ratio.py`). Each case's frame codestream is decoded alternately by CharLS (pyjpegls `_CharLS._decode`) and by our `examples/bench`, five rounds, keeping the minimum time per decode for each. The final code was used, at load average 15–20.

| Case (one frame) | CharLS ms | ours ms | ours ÷ CharLS |
|---|---|---|---|
| CT 128² s16 | 0.392 | 0.290 | 0.74 |
| CT 512² u16 | 3.10 | 2.81 | 0.91 |
| DX 2048² u12 | 70.1 | 67.5 | 0.96 |
| DX 2048² u12 NEAR 3 | 73.3 | 70.0 | 0.96 |
| RGB cine, frame 5 | 5.81 | 7.20 | 1.24 |
| CR 1841×1955 15-bit | 108.3 | 83.0 | 0.77 |
| SEG, frame 5 (64 bytes, nearly empty) | 0.008 | 0.020 | 2.57 |
| RGB 768×512 | 16.9 | 17.7 | 1.05 |

In cycles (`perf stat`, minimum of 3), the cine frame takes 28.8M against CharLS's 26.2M (1.10×), and the 2048² RGB ILV 2 stream takes 793M against 783M (1.01×).

**Where we stand:**
- **Mono, lossless and near-lossless:** at or below CharLS.
- **ILV 2 colour:** 1.05–1.26× CharLS; cine is the worst case. CharLS runs about 70 instructions per sample on cine; we run about 94. The difference is in the context and bias bookkeeping, which is on the serial dependency chain.
- **Nearly empty frames:** fixed per-frame costs dominate. Each scan copies its line buffers through an interleaved u16 buffer, and setup includes the 128 KiB quantiser table. In the benchmark, the SEG case as a whole comes out at 0.90–1.15× CharLS.
- **wasm-simd:** 1.2–1.8× slower than native (was 1.3–1.45×), and 1.5–2.0× faster than before.

## What changed

All changes are in `src/scan.rs`, `src/bits.rs` and the output path of `src/lib.rs`. The crate stays `#![forbid(unsafe_code)]`.

| Change | Effect |
|---|---|
| **Bit reader.** It refills up to 7 bytes at once when none is 0xFF (detected with a SWAR zero-byte test on the inverted word); otherwise it falls back to byte-wise stuffing. The cache holds at most 63 valid bits, so every consume shift is below 64. The refill's common case is inline. | Fewer, cheaper refills. The inline refill gave 2–3% (A/B). |
| **Golomb decode.** The prefix is counted with `leading_zeros`. The fast path takes prefix and suffix in one step when both are in the cache. The struct-based reader is used only for escapes and data ends. | Part of the first step (DX 2048: 110 → 70 ms in the benchmark). |
| **Hot state in locals.** Each line decoder copies the bit cache, the per-scan constants (`Consts`, passed by value) and the neighbours Ra/Rb/Rc into locals. Line decoders are `#[inline(never)]`, so each one gets its own register allocation. | Passing constants by value removed reloads after each context store: about 4% fewer instructions. |
| **Quantiser table.** A fixed 2^17-entry table is indexed by the gradient's low 17 bits (two's complement), so lookups need no offset and no bounds check. It is built with range fills, not one entry at a time. | Faster lookups and a cheaper per-scan setup. |
| **Contexts.** A fixed 512-entry array is indexed by `\|Q\| & 511`. | No bounds checks. |
| **Closed-form `k`.** Computed from the two bit lengths, with one compare to correct: k = bitlen(A) − bitlen(N), plus 1 when N·2^k < A. | Shorter than a loop on noisy data. A CharLS-style loop was tried: −7% on 12-bit mono, but +8–18% on RGB, so it was rejected. |
| **Branch-free bias cancellation and error correction.** For C: `clamp(C + hi − lo, −128, 127)`. For B: clamping to [−N + 1, 0] is a no-op when neither branch applies. | Branch misses on DX 2048 fell from 2.6M to 0.6M per frame (319M → 305M cycles). A branchy version was retested later and was worse on every stream (+30% on 12-bit mono). |
| **Branch-free MED.** Computed as median(Ra, Rb, Ra + Rb − Rc). | Small. |
| **Error cap 2·RANGE − 1.** Valid codes never exceed it, because escapes reach at most 2^qbpp < 2·RANGE. It bounds \|Errval\| by RANGE, so one modular wrap lands in [0, MAXVAL] and lossless reconstruction needs no clamp. | 12-bit mono: 302M → 288M cycles. |
| **Golomb lookup table, as CharLS does.** For k < 8, (k, next byte) maps to (length, unmapped Errval). It is built at compile time, and is only used when RANGE ≥ 128 so the error cap still holds. | RGB −6%, cine −6%; 12-bit mono +1%. A unit test checks every entry against the general decoder. |
| **ILV 2 path.** The component count is a const generic (1–4), and the per-component loops are unrolled by macro. | 2048² RGB: 881M → 806M cycles; cine: 34.5M → 32.4M. |
| **One interleaved sample buffer.** It replaces per-component planes and the per-sample `match` in the output loop. ILV 2 rows are copied straight across, and the output is a single width conversion. | Cine: 32.4M → 28.8M cycles; RGB: 806M → 793M. |
| **Specialisations.** `LOSSLESS` is a const generic (NEAR = 0 drops the step multiply and the near-lossless wrap). Run mode and run interruption stay generic. | |

## Not done, and why

- **i32 context variables.** A can exceed 2^31 when an LSE segment sets RESET near 65535, so A would need to stay i64. Splitting the fields gives no clear instruction saving.
- **Narrower line buffers.** Using u8 or u16 for 8-bit data matters only for nearly empty frames, where copying dominates: a 64-byte SEG frame takes 30 µs against CharLS's 10 µs. It does not matter for whole cases.
- **SIMD.** Decoding is serial per sample.
