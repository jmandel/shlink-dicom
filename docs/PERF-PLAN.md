# Performance plan: phase 2

Status: proposed (16 Oct 2026). Phase 1 was the decoder and encoder speed rounds that ended with the decoder-perf merge (8de3607).

**Goal:** keep making the codecs faster for as long as each change pays for itself, and stop each line of work at the point of diminishing returns or before it starts to cost maintainability. Matching the reference library is not a reason to stop, and falling short of it is not a reason to keep going.

## Where we stand

Our time ÷ the reference's time, single-threaded, same frames; below 1 means we're faster. From the quiet full run of 16 Oct, 13:53 (`codecs/bench/results/2026-10-16-18-53-28-quiet-full3.json`; load 1.2 when it started, no other benchmarks). Ours is the bench's codec stage per frame. The native references are the bench's own; the browser references are the C/C++ libraries built to wasm (Cornerstone, and libjxl 0.12 with SIMD), timed in the same Chromium worker. JPEG 2000 native uses `shl-j2k-bench` against OpenJPEG 2.5.4 through imagecodecs.

| Format | Reference | Native | Browser (wasm) |
|---|---|---|---|
| JPEG baseline, 8-bit colour | libjpeg-turbo 3.2 | 1.08–1.27 (2048² photo 1.27) | 0.46–0.56 |
| JPEG extended, 12-bit grey | libjpeg-turbo 3.2 | 0.55–0.58 | no wasm reference decodes 12-bit; 0.80–0.84 of *native* libjpeg-turbo's time |
| JPEG Lossless SV1 | libjpeg-turbo 3.2 | 0.46–0.65 | 0.45 (8-bit GE file, the only one the wasm reference decodes) |
| JPEG-LS | CharLS | grey 0.77–1.01; colour 1.07–1.18 | 0.82–1.19 |
| JPEG 2000 | OpenJPEG 2.5.4 | lossless 0.89–1.00; lossy 0.94–1.11 | 0.72–0.88 |
| HTJ2K | OpenJPH | 1.63–2.66 | large frames 1.17–1.20; small 0.82–1.04 |
| JPEG XL lossless | libjxl 0.12 | effort 1: 1.62–1.91; effort 7: 0.97–1.01 | effort 1: 1.67–1.81; effort 7: 1.06–1.09 |
| JPEG XL lossy | libjxl 0.12 | 2.28–2.99 | 1.28–1.77 |

**JPEG XL is being reconciled.** The bench measures our JPEG XL decodes 30–60% slower than the JPEG XL agent's own harness did, while libjxl's times agree between the two. The T6 figures (browser lossy 1.09–1.26×) came from that harness. Until the gap is explained, the bench figures above stand.

| Encoder, MB/s (higher is better) | Ours native | Reference native | Ours wasm | Reference wasm |
|---|---|---|---|---|
| JPEG Lossless SV1 (live CT / MR / XR series) | 343 / 329 / 355 | libjpeg-turbo 74.6 / 58.0 / 65.8 | – | none |
| JPEG 2000 lossless | 14.5 | OpenJPEG 17.6 | 13.1 | OpenJPEG about 17.4 |

## Rules for every change

A change is merged only if all of these hold:

- **Same output.** Byte-identical decodes on the four hash sets the decoder-perf round used: corpus at every scale, the live sample, the IDC long tail and the SOP sweep. Encoders produce byte-identical files to the previous build, wasm equal to native.
- **No `unsafe` in wasm, and none in crates that forbid it today.** Native AVX2 is allowed only as `#[target_feature]` functions (target_feature 1.1) behind one audited dispatch call each, and only in crates that already have it, unless Josh approves more.
- **No new dependencies.**
- **One implementation per algorithm.** Specialising with const generics or macros is fine. A SIMD kernel may sit beside its scalar version, which stays as the reference and is checked against it by a differential test. No second hand-written copy of anything else.
- **wasm size.** A change that adds more than 10 KB gzip to the viewer's decode module needs a measured end-to-end gain, since every viewer downloads that module.
- **Written down.** Each format's PERF.md records the change, its measured effect, and the attempts that were rejected.
- **Fuzzed.** Any changed entropy decoder or bit reader gets 10 minutes of fuzzing with no findings.

## When a track stops

- **A change is kept** if it saves at least 3% on one of the track's target cases (quiet A/B run or `perf stat` cycles), costs no more than 1% on any other case, and follows the rules above.
- **A track stops** when any of these happens:
  - three changes in a row are rejected or save less than 3%;
  - the profile shows the remaining time is in a serial dependency chain that is already close to the hardware limit (as with JPEG Huffman decoding at 7–8 cycles per coefficient);
  - the next idea would break a rule: it needs `unsafe`, a dependency, a second implementation, or a protocol change.
- **On stopping,** the format's PERF.md records the remaining gap to the reference, the next idea, and why it wasn't worth doing.

## Measurement

- **During the work:** `perf stat` instruction and cycle counts, and A/B runs that alternate the old and new binaries (as `/media/barracuda/dperf/abmin.sh` does). These hold up while other agents load the machine.
- **Final numbers:** only from `codecs/bench/run.mjs` runs the report doesn't mark **Noisy run**.
- **Concurrency:** at most two codec agents benchmark at a time, because each one's load spoils the other's numbers.
- **Cases:** headline figures come from real frames (Josh Example studies, IDC, the public test sets). Synthetic frames are fine for finding hot spots but are never quoted outside the PERF pages.
- **Weighting:** order the work by what the viewer actually decodes. SV1 is the default for shares and JPEG 2000 is the option. Everything else reaches the viewer only when it was already in the source files: JPEG baseline (ultrasound, slides), JPEG 2000 slides, JPEG-LS, HTJ2K and JPEG XL.

## Tracks

In order of user impact. Each track runs on its own short branch and lands as soon as a group of changes passes.

### T0. Measurement first

- One quiet `run.mjs` over every format, against every reference, natively and in Chromium; it replaces the tables above.
- ~~Find the cause of the 3–7% slowdown on small HTJ2K frames in wasm.~~ Done (cc784a5): it was in the measurement. The bench warmed up for only 2 decodes, so timed runs straddled V8's tier-up from Liftoff to TurboFan (about 25 decodes for a 2 ms frame). Warm-up now lasts at least 250 ms, and base and main match within 1.2%.
- ~~Stale pages and regression check.~~ Done (ddd23c8, 7dceba6): `node codecs/bench/check.mjs`.

### T1. SV1, decode and encode

This is the live path: every share is packed with SV1 in the browser, and every slice the viewer shows is decoded from it.
- ~~**Decoder.**~~ Stopped (2c6c5ce). The 1.1× figure predated the last lossless changes: on the live abdomen CT, 30 slices, we take 0.64× libjpeg-turbo's time. 85% of a decode is the serial Huffman chain, and the one idea left (an 11-bit lookahead for lossless) was 0.7% slower over the series. See jpeg-dct PERF.md, "SV1 on real CT series".
- **Encoder:** profile the browser packer (98.6 MB/s) with the end-to-end agent, which owns the packing pipeline.

### T2. JPEG 2000 lossless encoder

The share option, at 75–82% of OpenJPEG's speed. The remaining cost is about one branch misprediction per MQ symbol, so the next step is restructuring tier-1 coding. The self-check after encoding decodes the output again, which costs about as much as the encode, so T3 speeds up the share path too.

### T3. JPEG 2000 decoder

**Stopped.** The Leica 4:2:2 tile's colour output now works by rows and computes each shared chroma term once (78db6be): 2.0 → 1.3 ms against OpenJPEG's 1.35. Three tier-1 changes in a row then missed (padding stripes, a column state word held in a register, OpenJPEG-style MQ branching). On the lossy MR2 frame we run 40% more instructions than OpenJPEG but about the same cycles. The next idea, a rewrite of t1.rs in OpenJPEG's style, isn't worth it at 0.88–0.99× for lossless and 1.05–1.09× for slide tiles. See htj2k PERF.md.

### T4. JPEG baseline, 8-bit colour

**Stopped.** Kept: the wasm YCbCr→RGB kernel on 16-bit lanes (db16333), 7–10% fewer cycles on cine and slide tiles. Then three in a row missed: a native AVX2 colour kernel (−2–3% cycles), a fused 4:2:2 upsample-and-colour kernel in wasm (fewer instructions, more cycles), and a cheaper RGB interleave in wasm (V8 lowers the shuffles the same way). Natively we stay at 1.10–1.13× libjpeg-turbo on cine and slide tiles; in the browser we take 0.46–0.56× the time of libjpeg-turbo's wasm build. Streaming by MCU row wasn't tried: the planes of these frames are about 600 KB and the colour pass isn't memory-bound. See jpeg-dct PERF.md.

### T5. HTJ2K block decoder

The largest native gap (1.7–3.3× OpenJPH), and 1.2–1.25× in wasm. OpenJPH's speed comes from AVX2 per-lane variable shifts in MagSgn decoding, which wasm SIMD lacks. Start with a spike: a safe simd128 MagSgn/VLC prototype on the corpus blocks. **Gate:** if the prototype doesn't save at least 10% on large frames in wasm, record the result and stop the track.

### T6. JPEG XL lossy

**Stopped.** Kept: a safe four-lane type for the edge-preserving filter (EPF), dequantisation and transposes; tabulated scales; a fast path for effort-1 lossless; skipping the EPF on 8×8 blocks below the minimum sigma. Browser lossy went from 1.4–2.1× libjxl to 1.09–1.26× at distance 1. Three changes in a row then missed (per-group AC tables, 4-lane IDCT bundles, one copy fewer in the IDCT). Native lossy stays at 1.8–2.3× libjxl single-threaded; closing that needs AVX2 or threads within an image, both deferred. `run.mjs` now has nine JPEG XL cases with libjxl as the reference. See jpeg-xl PERF.md.

### T7. JPEG-LS colour (ILV 2)

1.05–1.24× CharLS. We run about 94 instructions per sample against CharLS's 70, in the context and bias bookkeeping on the serial chain. Grey is already faster than CharLS.

### T8. Removing `unsafe`

These reduce maintenance risk without costing speed:
- the JPEG decoder's five wasm `unsafe` blocks become safe lane operations (measured: 0–6% more instructions, no time change; confirm on a quiet machine);
- the JPEG decoder's native AVX2 moves to target_feature 1.1, about 15 `unsafe` blocks down to the dispatch calls.

## Questions for Josh before any work

- **Threads inside one frame in the browser.** wasm threads need SharedArrayBuffer, which needs the viewer page to be cross-origin isolated (COOP/COEP headers). That constrains what the page can load and embed. Today the viewer runs several frames at once in a worker pool, which covers series; threads would help only large single frames such as a 2048² JPEG 2000 lossless radiograph (about 370 ms in wasm).
- **AVX2 for JPEG 2000 and HTJ2K natively.** 5–11% at most, native only (server and CLI), and it would add the first `unsafe` to `shl-jpeg2000`. Recommendation: no.

## Sequencing

1. T0 first, by the decoder agent, which built most of the bench tooling.
2. Then T1, T3 and T4 with the decoder agent, T2 with the encoder agent, and T6 continuing. At most two of them benchmark at once.
3. T5's spike and T7 when a benchmarking slot frees up. T8 can run any time, since it needs only instruction counts and one quiet timing check.

The phase ends when every track has stopped under the rule above or been parked by Josh, with a final quiet scoreboard.
