# Performance plan: phase 2

Status: proposed (16 Oct 2026). Phase 1 was the decoder and encoder speed rounds that ended with the decoder-perf merge (8de3607).

**Goal:** keep making the codecs faster for as long as each change pays for itself, and stop each line of work at the point of diminishing returns or before it starts to cost maintainability. Matching the reference library is not a reason to stop, and falling short of it is not a reason to keep going.

## Where we stand

Our time ÷ the reference's time, single-threaded, same frames; below 1 means we're faster. The machine was shared during most runs, so read these as ±10%. [T0](#t0-measurement-first) replaces this table with one quiet run.

| Format | Reference | Native | Browser (wasm, vs the reference built to wasm) |
|---|---|---|---|
| JPEG baseline, 8-bit colour | libjpeg-turbo 3.2 | 1.07–1.21 | 0.50–0.68 |
| JPEG extended, 12-bit grey | libjpeg-turbo 3.2 | 0.58–0.67 | no wasm reference decodes 12-bit; ours beats native libjpeg-turbo |
| JPEG Lossless SV1 | libjpeg-turbo 3.2 | about 0.6 (2048²); 0.64 (live 512² CT series) | 0.45 |
| JPEG-LS | CharLS 2.4.4 | 0.74–0.96 grey; 1.05–1.24 colour | 0.94–1.12 |
| JPEG 2000 | OpenJPEG 2.5.4 | lossless 0.88–0.99; lossy 1.05–1.39; Leica 4:2:2 tile 0.96 (T3) | 0.76–0.79 |
| HTJ2K | OpenJPH 0.32 | 1.7–3.3 | 1.2–1.25 large frames; faster on small |
| JPEG XL lossless | libjxl 0.12 | 0.73–1.47 | 0.96–2.14 |
| JPEG XL lossy | libjxl 0.12 | 1.8–2.2 | 1.12–1.31 at distance 1 (after T6) |

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

MQ tier-1 decoding is about 90% of a lossless decode. Re-measure natively after the MQ table change, then try branch and table work in tier-1. The Leica 4:2:2 tile (2.0×) is mostly colour conversion that the reference leaves undone; check that before working on it.

### T4. JPEG baseline, 8-bit colour

Ultrasound cine and slide tiles. The largest remaining idea is decoding one MCU row at a time into buffers that stay in cache, instead of whole planes; the gap is widest on large frames (1.21× on 2048²). Then explicit wasm kernels for the h2v2 upsampler and 12-bit colour conversion, which still rely on auto-vectorisation.

### T5. HTJ2K block decoder

The largest native gap (1.7–3.3× OpenJPH), and 1.2–1.25× in wasm. OpenJPH's speed comes from AVX2 per-lane variable shifts in MagSgn decoding, which wasm SIMD lacks. Start with a spike: a safe simd128 MagSgn/VLC prototype on the corpus blocks. **Gate:** if the prototype doesn't save at least 10% on large frames in wasm, record the result and stop the track.

### T6. JPEG XL lossy

Running now on the scratch branch jxl-simd-spike (wasm SIMD first). It continues under these rules. Lossless is already level with libjxl.

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
