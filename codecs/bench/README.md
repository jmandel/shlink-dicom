# Decoder benchmarks

Measures how fast `shl_dicom_decode::decode_file` decodes the cases in `cases.json`. It runs natively, in Node and in headless Chromium, and compares the times with the reference C/C++ libraries. Every timed result is first checked against the codec-corpus oracle, so a fast result cannot be a wrong one.

Requirements:

- the rustup `stable` toolchain with the `wasm32-unknown-unknown` target;
- Node 22 or later;
- `/usr/bin/chromium` and `uv`;
- the corpus samples (see `codec-corpus/README.md`);
- `npm ci` in `codecs/bench`, which installs the pinned C/C++-in-wasm codecs.

Optional:

- `rustfilt` and `wasm-tools` (`cargo install rustfilt wasm-tools`), for readable wasm function names in profiles and for counting SIMD instructions in each wasm build;
- `perf` and `flamegraph`, for native profiles.

## Run

From the repository root:

```sh
node codecs/bench/run.mjs                          # everything: builds, all runners, report (about 15 min)
node codecs/bench/run.mjs --format jpeg-dct        # one format, all runners
node codecs/bench/run.mjs --quick --format jpeg-dct    # native + Node, simd build only (seconds)
node codecs/bench/run.mjs --case dx2048 --runners native,chromium-worker,chromium-cwasm --builds simd
node codecs/bench/run.mjs --help
```

Several runs can safely happen at once, for example from different agents:

- Each run builds while holding an exclusive `flock` on `codecs/bench/.build.lock`.
- While still holding the lock, it copies the native binary and the wasm files to its own directory, `codecs/target/bench/runs/<pid>-<time>/`, and runs only from there. That directory is removed at exit.
- A concurrent rebuild therefore can't replace a binary under a running benchmark, which previously failed with ETXTBSY.
- The runs still compete for CPU, though. The report header and the terminal summary say **Noisy run** when the 1-minute load average is above 1.5, or when another `run.mjs` or `profile.mjs` is running.

Each run writes `results/<date>-<label>.json` (and a copy in `results/latest.json`) and regenerates `report.html`, then prints a summary table. It exits 1 if any result fails to decode or verify.

## What gets measured

**Builds.** All four builds use the workspace release profile (opt-level 3, debug = 1) with `lto = "fat"` and `codegen-units = 1`, set through `CARGO_PROFILE_RELEASE_*` environment variables:

| Build | Target and flags |
|---|---|
| `native` | x86_64, default target CPU |
| `wasm-base` | wasm32-unknown-unknown |
| `wasm-simd` | wasm32 with `-C target-feature=+simd128` |
| `wasm-relaxed` | wasm32 with `+simd128,+relaxed-simd` |

| `wasm-base-opt`, `wasm-simd-opt` | the same builds after binaryen `wasm-opt -O3 -g` with the module's own features enabled (read from its `target_features` section) |

The wasm module comes from `codecs/shl-dicom-wasm-bench`, which exposes a few raw `bench_*` exports and no wasm-bindgen glue. Sizes are reported with custom sections stripped, raw and gzip -9. The unstripped files in `codecs/target/bench/out/` keep demangled function names for profiling.

**Runners.**

| Runner | What it runs |
|---|---|
| `native` | `bench-native`, one process per case. On Linux it is pinned to one CPU, so multi-frame files, which the decoder otherwise splits across threads, are timed single-core too. |
| `node` | the wasm builds in V8, in-process |
| `chromium-worker` | headless Chromium; each build runs in a fresh dedicated Web Worker, so main-thread work cannot interfere. The page is cross-origin isolated, which gives `performance.now()` 5 µs resolution. |
| `chromium-cwasm` | C/C++ codecs compiled to wasm, in the same worker, right after our builds on each case. These are the Cornerstone packages that a browser viewer would otherwise use (versions pinned in `package.json`): `@cornerstonejs/codec-libjpeg-turbo-8bit`, `codec-charls`, `codec-openjpeg`, `codec-openjph`. They decode the frame codestreams produced by our own frame splitter (`bench_extract_frames`), and only their `decode()` call is timed. |
| `chromium-main` | the same loop on the page's main thread (simd build only), for comparison |
| `ref` | native C/C++ libraries timed in-process from Python (`reference/ref_bench.py`): libjpeg-turbo (Pillow and imagecodecs), libjpeg (pylibjpeg), CharLS (pyjpegls), OpenJPEG (pylibjpeg), OpenJPH (imagecodecs), pylibjpeg-rle and GDCM |

**Per case.** Each runner does the following:

1. Copies the file into memory.
2. Decodes it once. This is the "first decode" time, which includes wasm memory growth and V8 tier-up.
3. Checks that output against the oracle `.npy`: exact match, or within the case's `max_abs` for lossy syntaxes.
4. Runs the remaining warm-up decodes.
5. Runs the measured decodes: enough to fill 300 ms, at least 5 and at most 30, or only 3 when one decode takes more than 2 s.

Every measured decode must return the same output hash as the verified one. Reported numbers are the median, p10 and p90.

**Stages.** The timing shim wraps each codec call through `decode_file_with`, so the decoder itself is unchanged. It splits each decode into three stages:

- `parse`: from the start to the first codec call (DICOM parse and frame split).
- `codec`: time inside the codec's `decode_frame`, summed over frames.
- `normalise`: everything else (planar interleave, Bits Stored masking, YBR→RGB, copying frames into the output).

Uncompressed files have no codec call, so their whole decode counts as `parse`.

**Native memory.** The native runner sets `GLIBC_TUNABLES` so that glibc keeps freed memory, as wasm does. Otherwise every run page-faults its output buffer back in: RLE 512² takes 1.0 ms instead of 0.2 ms.

**C/C++ libraries.** Both sets of C/C++ libraries are timed on frame codestreams only, so each is compared with our `codec` stage. They form two separate comparisons, never mixed in one ratio:

- **vs C compiled to wasm (same browser):** our wasm-simd codec stage ÷ the fastest Cornerstone package on that case. Both run in the same Chromium worker, on the same bytes, under the same conditions. This is the like-for-like comparison for the browser.
- **vs native C (Python in-process):** our *native* codec stage ÷ the fastest single-threaded native library.

The C-in-wasm outputs are checked against the oracle like ours. They are reordered from planar and masked to Bits Stored first, outside the timing. A library whose output differs by more than the case's `max_abs` still shows its time, marked ≠. Its rounding differs from the oracle's (for example libjpeg-turbo's upsampling), so treat that comparison with care.

Which package covers which format:

| Package | Covers | Wasm SIMD |
|---|---|---|
| libjpeg-turbo-8bit | 8-bit JPEG, including 8-bit lossless; refuses 12-bit (extended and lossless) and 16-bit lossless | no |
| CharLS | JPEG-LS | no |
| OpenJPEG | JPEG 2000 and HTJ2K | no |
| OpenJPH | HTJ2K | yes |

RLE and uncompressed have no package. Each package's SIMD use is measured with `wasm-tools` and recorded in the results.

GDCM decodes the whole file and uses threads for JPEG 2000. The report lists it but never uses it for a ratio, and flags any native library whose CPU time exceeds 1.3× its wall time.

## wasm-opt

The `-opt` builds run `wasm-opt` (binaryen, `~/.local/bin/wasm-opt` or `$WASM_OPT`) on the cargo output. The settings:

- DWARF is stripped first, and `-g` keeps the name section, so the optimised builds can still be profiled.
- The `--enable-*` flags are exactly the features in the module's `target_features` section (bulk-memory, bulk-memory-opt, call-indirect-overlong, multivalue, mutable-globals, nontrapping-float-to-int, reference-types and sign-ext, plus simd for the simd build).
- Every run checks that each `-opt` build's output hash equals its source build's on every case. A difference fails the run.
- `WASM_OPT_LEVEL` changes the level. `-O3`, `-O4` and `-Oz` were compared on the 2048² DX cases (one per format, interleaved in a Chromium worker):

| Level | Speed vs unoptimised | Raw size | gzip size |
|---|---|---|---|
| `-O3` | within noise (±5%) | −11% | −1 to −2% |
| `-O4` | within noise (±5%) | −11% | −1 to −2% |
| `-Oz` | within noise (±5%) | −11% | −1 to −2% |

All three gave identical output. Rust's own LTO and opt-level 3 already did the work, so `-O3` is kept as the default.

## Reading the report

Open `codecs/bench/report.html`. It has these parts:

- **By format:** geometric means over the format's cases:
  - `simd ÷ native`: how much slower the browser build is than native;
  - `base ÷ simd`: what simd128 buys;
  - **vs C compiled to wasm (same browser):** our wasm-simd codec time ÷ the fastest C/C++ codec built to wasm. This is the number to use when the question is how we compare with the C codecs as a browser decoder.
  - **vs native C (Python in-process):** our native codec time ÷ the fastest native C/C++ library. This is the number to use when the question is how good the Rust code is, without wasm in the picture.
  - MP/s for the largest case.

  Below 1× means ours is faster. The two C comparisons are never combined: wasm against native C would mostly measure the WebAssembly penalty.
- **One table per format:**
  - times in ms for native, the three wasm builds in a Chromium worker, main-thread simd and Node simd;
  - the stage split for wasm-simd and native;
  - two column groups, one per C comparison, each with our codec time, the ratio, and every library's time (≠ marks a library whose output did not match the oracle; "does not decode this case" means the package refused the codestream).

  Hover a time to see p10/p90, the run count, the first-decode time, the verification result and the baseline time. A red ✗ marks a result that failed verification.
- **Compared with \<baseline\>:** shown when a baseline exists. A change is marked (▲ slower, ▼ faster) only when it is at least 5% **and** the p10–p90 ranges of the two runs do not overlap. If the decoder source fingerprint is the same in both runs, the report says that any marked change is noise.
- **Builds and environment:**
  - wasm sizes;
  - CPU and governor;
  - load average and other bench runs at the start and end (the header warns about a noisy run above 1.5, or when another run was in progress);
  - Chromium and Node versions;
  - git HEAD and a hash of every `.rs` and `Cargo.toml` file under `codecs/`.

## Baselines

```sh
cp codecs/bench/results/latest.json codecs/bench/results/baseline.json   # make the last run the baseline
node codecs/bench/run.mjs --format jpeg-dct                               # later runs compare with it
node codecs/bench/run.mjs --baseline codecs/bench/results/<run>.json      # or name one
node codecs/bench/report.mjs codecs/bench/results/<a>.json --baseline codecs/bench/results/<b>.json
```

Only the same case, runner and build are compared, so a single-format run compares cleanly with a full baseline. Results depend on the machine, so compare runs from the same machine only.

## Profiling a slow case

```sh
node codecs/bench/profile.mjs photo-rgb8-2048-ijg            # wasm-simd in Chromium
node codecs/bench/profile.mjs dx2048-u12-openjph-rev --build wasm-base --native --seconds 6
```

This decodes the case in a loop on the page's main thread with the V8 sampling profiler running and a DevTools trace recording. It writes these files to `profiles/`:

- `<case>-<build>.txt`: self time by crate and by function, also printed;
- `<case>-<build>.cpuprofile`: drag into Chrome DevTools > Performance, or open in speedscope.app;
- `<case>-<build>.trace.json`: open in DevTools > Performance or ui.perfetto.dev. The Timings track shows a "parse+split" and a "codec+normalise" span for each decode.

With `--native` it also writes:

- `<case>-native.txt`: from `perf record` of `bench-native --loop`;
- `<case>-native.svg`: a flame graph, when `flamegraph` is installed.

Function names are demangled Rust paths (`<shl_codec_jpeg::dct::DctDecoder>::idct_into`). Functions inlined by LTO are counted in their caller.

To profile by hand in a headed browser:

1. Start the server: `node -e 'import("./codecs/bench/lib/server.mjs").then(m=>m.serve()).then(s=>console.log(s.origin))'`.
2. Open `<origin>/bench/web/index.html`.
3. Record in DevTools while calling `benchRun({build:"wasm-simd", opts:{warmup:2,min_runs:5,max_runs:30,budget_ms:300}, marks:true, cases:[{id:"x", fmt:"jpeg-dct", corpusId:"gen-bench-photo-rgb8-2048-ijg-baseline", max_abs:4}]}, "main")`.

## Adding a case

1. The case must first exist in the corpus, with an oracle:
   - Existing files are added through `codec-corpus/scripts/discover.py` or `generate.py`.
   - Large synthetic images are added to `SEEDS` in `scripts/make_cases.py`. Each seed is a deterministic modality-like image plus the encoders to use. Run:

     ```sh
     uv run --project codec-corpus python codecs/bench/scripts/make_cases.py --only <seed>
     ```

     This registers `gen-<seed>-<encoder>` cases through `generate.register()` and builds their oracle. Correctness tests then cover them like any other case (`check.py --case gen-bench`).
2. Add an entry to `cases.json` with these fields:
   - `id`: `<format>/<corpus case id>`;
   - `label`;
   - `tags`;
   - `sample_sha256` and `oracle_sha256`, copied from the format's `cases.json`.

   Bump `version` when the set changes, so results from different sets are not mixed up. A regenerated synthetic file gets new UIDs and so a new `sample_sha256`, while its pixels stay the same; the runner warns when either hash differs from the manifest.

## The optimise, measure, verify loop

For an agent working on a codec, say `shl-codec-jpeg`:

1. **Baseline.** Before changing anything:

   ```sh
   node codecs/bench/run.mjs --format jpeg-dct --runners native,chromium-worker --builds simd --label before
   cp codecs/bench/results/latest.json codecs/bench/results/baseline.json
   ```

2. **Find the hot spot.** Run `node codecs/bench/profile.mjs <case> --native` on the slowest case. Optimise what the `.txt` summary puts at the top, not what you expect to be slow.
3. **Change one thing,** then re-run the same command. The run rebuilds automatically.
4. **Read the result.**
   - **Exit code 1:** some output no longer matches the oracle. The change is wrong, whatever the speed.
   - **▲ entries in the comparison:** regressions.
   - **No marked change:** within noise. Don't keep changes whose only support is a sub-5% median shift.
5. **Before reporting,** run `codec-corpus/scripts/check.py --format <fmt>` for full correctness. The bench verifies only its own cases.
6. **Report:**
   - the before/after `simd` and `native` medians;
   - the "vs C in wasm" ratio for browser claims, or the "vs native C" ratio for claims about the Rust code itself. Name which one you mean.

Other agents share the machine. If the report warns about load, re-run before drawing conclusions. Take baselines on a quiet machine: a single slow measurement in the baseline later shows up as a false "improvement". When the decoder source is unchanged between two runs, the report says so, and every marked change is noise.
