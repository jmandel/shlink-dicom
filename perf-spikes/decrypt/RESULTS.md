# Series-file decryption in the browser: wasm `aes-gcm` vs WebCrypto

Question: is decrypting series-file records (PROPOSAL.md §9: 65,536-byte AES-256-GCM records, nonce `uint96_be(i)`) with the Rust `aes-gcm` crate compiled to wasm a bottleneck, and is WebCrypto faster once its per-call cost is counted?

Answer: yes and yes. In Chromium, WebCrypto decrypts series records 15–20× faster than `aes-gcm` in wasm: about 800 MB/s against about 50 MB/s on one thread. For most transfer syntaxes the wasm decrypt costs as much CPU as decoding, or more. With WebCrypto it costs a small fraction. `record-decrypt.ts` is a drop-in module for the WebCrypto path.

## Setup

- AMD Ryzen 5 3600 (6 cores, 12 threads), Linux, headless Chromium 154 (`/usr/bin/chromium`), cross-origin isolated page (5 µs timers).
- The wasm code is `aes-gcm` 0.10.3 / `aes` 0.8.4 / `polyval` 0.6.2, the versions in the repository `Cargo.lock`, built for wasm32-unknown-unknown with the release profile (opt-level 3, fat LTO, one codegen unit). It has no AES or carry-less-multiply instructions on wasm, so it uses the crates' constant-time software backends. There are four builds: base, `+simd128`, and each of those after `wasm-opt -O3`.
- The Rust code has two paths:
  - **as-is** copies `shl_dicom_core::crypto::decrypt_record`: a new `Aes256Gcm` (key schedule) and a new `Vec` for every record, as `ingest_ciphertext_range` does today.
  - **tuned** sets the key once and decrypts in place.
- Every wasm call includes copying ciphertext into wasm memory (1 MiB batches) and plaintext back out. Every WebCrypto call includes copying its result into one contiguous output buffer.
- MB/s means ciphertext bytes ÷ 10⁶ ÷ seconds, median of the runs (30 runs at 1 MB, 3 at 50 MB, 2 at 400 MB). The sizes are 16, 763 and 6,104 full records.
- Other agents were using the machine throughout, with a load average of 4.5–12 during the reference run (`results/2026-10-15-11-58-26.json`). Two later runs at load 16–26 (`results/*-loaded-discard.json`, `results/2026-10-15-12-52-42.json`) show the same ordering with lower and noisier numbers. Treat individual cells as ±15%. The ratios are much larger than that.

## Throughput (MB/s)

| Path | Context | 1 MB | 50 MB | 400 MB |
|---|---|---:|---:|---:|
| native Rust, AES-NI + PCLMULQDQ, tuned | — | 1207 | 1191 | 1184 |
| native Rust, AES-NI + PCLMULQDQ, as-is | — | 1164 | 1055 | 1040 |
| native Rust, software AES forced, tuned | — | 118 | 118 | 115 |
| wasm base, tuned | worker | 43 | 42 | 42 |
| wasm base + wasm-opt -O3, tuned | worker | 41 | 41 | 32 |
| wasm simd128, tuned | worker | 52 | 49 | 51 |
| wasm simd128 + wasm-opt -O3, tuned | worker | 52 | 52 | 52 |
| wasm simd128 + wasm-opt -O3, as-is | worker | 52 | 47 | 45 |
| wasm simd128 + wasm-opt -O3, tuned | main | 46 | 45 | 50 |
| WebCrypto, one call per record, sequential | worker | 733 | 845 | 831 |
| WebCrypto, K = 4 in flight | worker | 768 | 749 | 810 |
| WebCrypto, K = 16 in flight | worker | 746 | 752 | 810 |
| WebCrypto, K = 64 in flight | worker | 749 | 767 | 815 |
| WebCrypto, sequential | main | 736 | 898 | 920 |
| WebCrypto, K = 16 | main | 794 | 912 | 896 |
| WebCrypto K = 16, 2 workers in parallel | workers | — | 1108 | 1288 |
| WebCrypto K = 16, 4 workers | workers | — | 2135 | 1591 |
| WebCrypto K = 16, 6 workers | workers | — | 2910 | 1918 |
| WebCrypto K = 16, 12 workers | workers | — | 3032 | 1829 |
| wasm simd-opt, 2 workers | workers | — | 91 | 47 |
| wasm simd-opt, 6 workers | workers | — | 215 | 149 |
| wasm simd-opt, 12 workers | workers | — | 252 | 190 |

The full table, including the as-is and main-thread rows for every build, is in `results/2026-10-15-11-58-26.json`.

Notes on the table:

- **Wasm runs at 40–52 MB/s.** That is about half of the same software AES running natively (115 MB/s) and 1/23 of native with AES-NI. simd128 adds about 20% through auto-vectorisation; neither crate has a wasm SIMD backend. `wasm-opt -O3` adds nothing. Setting the key once (tuned) instead of per record (as-is) also changes nothing measurable: the cost is the software AES and GHASH themselves.
- **WebCrypto runs at 750–920 MB/s per thread.** That is 70–80% of native `aes-gcm` with hardware AES, and 15–20× the wasm build.
- **Each WebCrypto call has a fixed cost of 5–20 µs.** Decrypting a 16-byte plaintext takes 12–20 µs per call when the calls are awaited one at a time, and 5–7 µs per call with 16–64 in flight. One 16 MiB call runs at about 1,190 MB/s, so a 64 KiB record costs about 55 µs of AES-GCM work plus that fixed cost. The fixed cost is 10–25% of each record's time.
- **More calls in flight do not help in one context.** K = 4, 16 and 64 match sequential within noise. More workers do help: WebCrypto in a pool reaches 2–3 GB/s at 50 MB. At 400 MB the pool is limited by memory bandwidth and by the other load on the machine.

### WebCrypto blocks the calling thread in Chromium

`probe-thread.mjs` sends MessageChannel pings on the page's main thread while it decrypts. It counted zero pings during one 64 MiB `decrypt` call (51 ms), and zero during 800 record-sized calls with 16 in flight (56 ms). The same zero shows in the harness (`runJank`): 50 MB with WebCrypto blocked the main thread for 60–70 ms as one task, and the wasm path for 1.55 s.

So in Chromium the AES work runs on the calling thread, and a chain of resolved decrypts never yields to other tasks. This explains why K > 1 does not speed anything up while separate workers do. It also means decrypting on the main thread costs about 80 ms of frozen UI per 64 MB. Firefox and Safari were not measured.

## Correctness

Every path was checked in both the worker and the main thread: 12 paths × 17 checks, all passing. Each path:

- reproduces the PROPOSAL Appendix B vector: the plaintext SHA-256 and the three record tags;
- decrypts a range read of records 1 to the end;
- decrypts a real series file to its original bytes. `fixtures/wrist.bin` is the three wrist-low-res DICOM Part 10 instances (6.04 MB, 93 records), encrypted with `reference/series-file.ts` by `make-fixtures.ts`;
- rejects a flipped ciphertext bit, a flipped tag bit, swapped records, a record presented at the wrong index, a final record truncated by one byte, and the wrong key.

`record-decrypt.test.ts` (`bun test perf-spikes/decrypt/record-decrypt.test.ts`, 27 tests) covers the module against the same vector and the real file. It also covers:

- instance 2 as a range read;
- an exact-size window;
- tampering outside the window;
- length checks when the series length is known;
- zeroing the output after a failure;
- a non-extractable, decrypt-only key;
- nonces above 2³².

## What it means for a 50 MB series and a 390 MB study

| | 50 MB series | 390 MB study (≈ 6,200 records) |
|---|---:|---:|
| wasm simd, one thread (≈ 50 MB/s) | ≈ 1.0 s | ≈ 7.8 s |
| wasm simd, 6 workers (≈ 150–215 MB/s) | ≈ 0.25 s | ≈ 2–2.6 s, on every core |
| WebCrypto, one worker (≈ 800 MB/s) | ≈ 0.06 s | ≈ 0.5 s |
| WebCrypto, 6 workers (≈ 1.9–2.9 GB/s) | ≈ 0.02 s | ≈ 0.15–0.2 s |
| network at 100 Mbit/s / 1 Gbit/s | 4 s / 0.4 s | 31 s / 3.1 s |

A wasm decrypt on one thread processes about 400 Mbit/s. On a fast connection it is slower than the download, so it would be the first limit on how soon pixels appear. WebCrypto in one worker processes about 6.5 Gbit/s, which no realistic link reaches.

## Decryption or decoding: which is the bottleneck

The comparison must be made on input bytes, because every byte of the series file passes through decryption once, and decoding consumes those same bytes. The figures below are rates for our decoder (`shl_dicom_decode`, wasm-simd) in a Chromium worker, from `codecs/bench/results/2026-10-15-08-57-26-full.json`, the last full run. The large cases are listed for each format.

| Transfer syntax | Decode MP/s | Decoder input MB/s | wasm decrypt (50 MB/s) as a share of decode time | WebCrypto (800 MB/s) |
|---|---:|---:|---:|---:|
| Uncompressed (CT 512², DX 2048²) | 2,600–13,000 | 5,000–26,000 | 100–500× decode time | 6–30× |
| RLE (DX 2048², CT 512²) | 640–1,030 | 600–640 | ≈ 12× | ≈ 0.8× |
| JPEG lossless (DX 2048², CT 512², multiframe) | 160–190 | 60–120 | 1.2–2.4× | 8–15% |
| JPEG baseline/extended | 150–220 | 20–75 | 0.4–1.5× | 3–9% |
| JPEG-LS | 20–40 | 11–25 | 20–50% | 1–3% |
| JPEG 2000 | 5–30 | 2–6 | 4–12% | < 1% |
| HTJ2K | 3–13 | 2–7 | 4–14% | < 1% |

For uncompressed, RLE and JPEG lossless data, which covers most CT and MR, the wasm decrypt is the bottleneck. It takes as long as decoding or longer, and up to hundreds of times longer for uncompressed data, where decoding is close to a copy. For example, a 390 MB uncompressed CT study needs about 8 s of single-thread wasm decrypt and well under 0.1 s of decode.

Only for the JPEG 2000 family and JPEG-LS is decoding clearly the larger cost, with the wasm decrypt adding 4–50% to it.

With WebCrypto, decryption is negligible next to every compressed decoder. For uncompressed data it remains the larger cost on paper, but at about 0.5 s per 390 MB it is far below download time.

## Recommendation for the viewer

1. **Decrypt with WebCrypto, not `aes-gcm` in wasm.**
   - Use `perf-spikes/decrypt/record-decrypt.ts`: `importSeriesKey(raw)` and `decryptRecords(key, ciphertext, firstRecordIndex, opts)`.
   - The series key then never enters wasm memory. It is imported once per series as a non-extractable `CryptoKey`.
   - Tuning the Rust path is not worth it. Per-record re-keying, `wasm-opt` and simd128 together move it by about 20%.
   - Keep the Rust `decrypt_range` for native code (server, CLI). There, `aes` uses AES-NI and runs at 1.1 GB/s.

2. **Decrypt in the decoder workers that viewer-kit's `DecoderPool` runs, not on the main thread.**
   - In Chromium, WebCrypto runs on the calling thread and its resolved promises chain without yielding. 50 MB on the main thread is one 60–70 ms task. With today's wasm path it is a 1–1.5 s task.
   - The decoder workers already exist and run in parallel, so decryption scales with them: 2–3 GB/s for 6 workers in this measurement.
   - A `CryptoKey` is structured-cloneable and stays non-extractable when posted, so each worker receives the series key once.

3. **Hand plaintext to the decoder without extra copies.** For one instance, `[a, b)` in series plaintext, with `first = ⌊a / 65,520⌋`:
   1. The fetch layer requests the ciphertext range (§9.3) and transfers the response's `ArrayBuffer` to the decoder worker. No copy.
   2. The worker calls `decryptRecords(key, ct, first, { window: { start: a − 65,520·first, length: b − a }, seriesPlaintextLength })`. Each record's plaintext is copied once, straight to its place in a buffer of exactly the instance's size. Bytes of the partial records at either end outside the instance are verified but not kept.
   3. The worker passes that buffer to `WasmDecoder.decode`, which copies it into wasm memory once, as it does today.

   That makes three copies in all, two of them inside WebCrypto. Today's `ingest_ciphertext_range` already makes three before any instance is assembled:
   - wasm-bindgen copies the ciphertext into wasm memory;
   - `aes-gcm` decrypts into a newly allocated `Vec` per record;
   - the `Vec` goes into the record cache, from which instances are later assembled.

   A further copy could be saved by passing `opts.output` as a view of the decoder's wasm input buffer. That is safe only if nothing grows that memory while the calls are in flight. In Chromium the calls complete synchronously, so nothing can grow it then. The WebCrypto specification does not promise this, so do it only if profiling shows the copy matters, which at about 10 GB/s memcpy it will not.

4. **Change `WasmShlSession` to match.**
   - `ingest_ciphertext_range` stops decrypting.
   - Either the bounded record cache moves to JS, holding verified plaintext keyed by `(fileId, record)` or by instance, or the session gains an ingest call for plaintext that JS has already verified.
   - The length checks that `ingest_ciphertext_range` does now move to `decryptRecords` via `seriesPlaintextLength`:
     - non-final records must be 65,536 bytes;
     - the final record must be its remainder plus 16;
     - no record may lie past the end.
   - A whole-file read must still compare the total ciphertext length with `ciphertextLength(P)`, because a range missing its trailing records is otherwise a valid range read.

5. **Bulk download or prefetch without decoding:** one dedicated worker running `decryptRecords` at the default concurrency is enough. It sustains about 800 MB/s.

## Files

- `record-decrypt.ts` is the drop-in module, and `record-decrypt.test.ts` holds its tests (Bun; the module also runs in Node 20+ and Deno).
- `rust/` is the benchmark crate:
  - a copy of `decrypt_record` and an in-place variant;
  - raw wasm exports with no wasm-bindgen;
  - the native `bench-native` binary.
- `build.sh` builds:
  - native, and native with software AES forced;
  - the four wasm builds;
  - `bench/record-decrypt.js`;
  - the fixtures, if missing.
- `run.mjs` runs:
  - native;
  - Chromium in a worker, on the main thread and in worker pools;
  - the main-thread probe.

  It writes `results/<date>.json` and `results/latest.json`. `node run.mjs --quick` runs only the 1 MB and 50 MB sizes and skips the pools.
- `bench/` holds the page, worker and benchmark code. The same `decrypt(ct, first)` function per path is used for the correctness checks and for timing.
- `probe-thread.mjs` checks whether `crypto.subtle.decrypt` leaves the calling thread free.
- `make-fixtures.ts` writes `fixtures/vector.*` (Appendix B) and `fixtures/wrist.*` (a real series file).

To reproduce, run `./build.sh && node run.mjs` from this directory, and `bun test perf-spikes/decrypt/record-decrypt.test.ts` from the repository root. Run the benchmark on an idle machine: the numbers here were measured under load from other jobs.
