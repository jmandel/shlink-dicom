# JPEG 2000 and HTJ2K crate survey

Phase 1 survey by the j2k-survey agent, 2026-10-14. Question: for JPEG 2000 (`1.2.840.10008.1.2.4.90`/`.91`) and HTJ2K (`.201`/`.202`/`.203`), adopt a pure-Rust crate from crates.io or build our own.

Everything here can be re-run from `codecs/survey-j2k/`, a standalone Cargo workspace outside `codecs/Cargo.toml`:

```sh
cd codec-corpus
uv run python scripts/extract_frames.py --format jpeg2000 && uv run python scripts/extract_frames.py --format htj2k
(cd ../codecs/survey-j2k && CARGO_TARGET_DIR=target cargo build --release)
uv run python ../codecs/survey-j2k/score.py --json ../codecs/survey-j2k/results.json   # all candidates, both formats
uv run python ../codecs/survey-j2k/fuzz.py hayro 300 --only jpeg2000                     # 5-minute mutation fuzz
```

## Decisions

| Format | Decision |
|---|---|
| jpeg2000 | **Adopt `hayro-jpeg2000` 0.4.x** behind a thin wrapper in `shl-codec-jpeg2000`. The wrapper validates SIZ, strips any JP2 wrapper, corrects signed components and clamps. Passes 35/36 corpus cases now, and 36/36 once one tolerance is corrected (see [Rulings](#rulings-on-disputed-and-questioned-cases)). |
| htj2k | **Wrap `oxideav-jpeg2000` 0.0.x** in `shl-codec-htj2k`, with the same SIZ validation. Passes 20/20. It is correct and memory-safe, but 15–40x slower than OpenJPH-class decoders, so the [phase 2 plan](#phase-2-plan) includes a speed gate and, if that fails, a contingency: an HT block decoder of our own, plugged into hayro's pipeline. |

Neither format needs a from-scratch build. If one turns out to be needed, the [build estimate](#build-estimate-contingency) gives the module breakdown and the order of work.

## Candidates

| Crate | Version | Licence | Formats | Pure Rust | `unsafe` | wasm32 | Maintenance |
|---|---|---|---|---|---|---|---|
| `hayro-jpeg2000` | 0.4.1 | MIT/Apache-2.0 | Part 1 | yes; deps `fearless_simd` (`simd`, default), `image`+`moxcms` (`image`, default; drop it) | 0 (`#![forbid(unsafe_code)]`); `fearless_simd` has internal unsafe, removable with `default-features = false` | yes | 4.0 M downloads (3.6 M in 90 days, via the hayro PDF renderer); 11 releases since 2025-12; repo 798 stars, 30 contributors, pushed 2026-10-14 |
| `oxideav-jpeg2000` | 0.0.17 | MIT | Part 1 + HTJ2K (+ encoder) | yes; zero deps with `default-features = false` | 0 occurrences (no `forbid` attribute) | yes | 2 k downloads; 15 releases since 2026-04; one maintainer, 1 star; active (perf work open) |
| `rust-j2k` | 0.3.0 | MIT/Apache-2.0 | Part 1 (GRIB2-oriented) | yes; zero deps | 0 | yes | 4.8 k downloads; 3 releases since 2026-06; 2 contributors |
| `j2k` (+`j2k-native`) | 0.12.0 | MIT/Apache-2.0 | Part 1 + HTJ2K | yes; deps rayon, thiserror, moxcms, fearless_simd | `j2k-native` forbids; `j2k-core` 7 (GPU ABI, `xgetbv`) | not verified: MSRV 1.99, and the local wasm-capable toolchain is 1.97 | 7 k downloads; 18 releases since 2026-06; 2 contributors; hayro fork, 100 k lines |
| `openjpeg2-pure-rs` | 0.1.1 | BSD-2-Clause | Part 1 + HTJ2K | yes; zero deps | 228 | yes | 1.2 k downloads; LLM translation of libopenjp2 released 2026-08; one maintainer |
| `openjp2` | 0.6.1 | BSD-2-Clause | Part 1 + HTJ2K | Rust, but calls C `calloc`/`realloc`/`free` | 482 (c2rust-style transpile) | **no**: undefined `calloc`, `realloc`, `free` at link, even with `default-features = false` | 217 k downloads; last push 2026-02 |
| `openjph-core` | 0.1.0 | BSD-2-Clause | HTJ2K only | yes; dep thiserror | 104 | yes | 11 k downloads (mostly via `dicom-toolkit-jpeg2000`); one release; no repository link |
| `ndic-htj2k` + `ndic-codestream` | 0.2.5 | MIT | HTJ2K only: single tile, reversible, one layer | yes | 10 (SIMD DWT) | yes | 220 downloads; 2026-08 |
| `dicom-toolkit-jpeg2000` | 0.5.0 | MIT/Apache-2.0 | Part 1 (hayro fork) + HTJ2K via `openjph-core` | yes | 0 own | yes | 14 k downloads; last release 2026-03 |
| `justjp2` | 0.1.1 | MIT/Apache-2.0 | Part 1 | yes | 0 | yes | 1.6 k downloads; 2026-03 |
| `pure_jpeg2k` | 2.0.0 | MIT/Apache-2.0 | Part 1, unsigned 16-bit single-component only | yes | 0 | not built | 246 downloads |
| `oxigdal-jpeg2000` | 0.1.7 | Apache-2.0 | Part 1, 8-bit RGB output only | yes | 0 | not built | 365 downloads |

Not evaluated separately: `ps-hayro-jpeg2000` and `pdfluent-jpeg2000` (hayro forks), `jpeg2000`, `jpeg2k`, `openjpeg-sys` and `grokj2k-sys` (C bindings).

Unsafe counts are lines containing `unsafe` in `src/`, excluding comments. Downloads and dates are from the crates.io and GitHub APIs on 2026-10-14.

## Corpus results

Each adapter (`adapters/<name>/src/main.rs`) decodes one extracted codestream to i32 samples. `score.py` then applies the CONTRACT normalisation (mask or sign-extend to Bits Stored) and compares with the oracle. Two wrapper steps are applied uniformly, because our crate would do the same:

- **JP2 unwrap:** if the frame starts with the JP2 signature, the `jp2c` payload is passed through to the end of the buffer, including the DICOM pad byte; codestream decoders stop at EOC.
- **Clamp:** samples are clamped to the component's SIZ range, as OpenJPEG does after the inverse DC shift. This is a no-op for lossless output.

**Sign fix (`s`):** a third step, marked `s` in the tables. When SIZ marks a component signed but the decoder returned unsigned, level-shifted values, the scorer subtracts 2^(p−1). Only hayro and its fork dtk needed it. Hayro reads the SIZ sign bit and discards it (`codestream.rs`: "No idea how to process signed images").

Legend:

| Code | Meaning |
|---|---|
| `=` | exact |
| `~` | within `max_abs` |
| `=s`, `~s` | passes with the sign fix |
| `W<n>` | wrong, largest difference n |
| `E` | decoder error |
| `rej` | refused, on the expect=error case |
| **ABORT** | process abort |

### Per-case results

#### jpeg2000

| case | max_abs | hayro | oxideav | rustj2k | j2k | ojpure | openjp2 | openjph | ndic | dtk |
|---|---|---|---|---|---|---|---|---|---|---|
| `gen-local-mri-slice-openjpeg-cr20` | 1 | ~s | ~ | ~ | ~ | = | = | E | E | W583 |
| `gen-local-mri-slice-openjpeg-rev` | 0 | =s | = | = | = | = | = | E | E | =s |
| `gen-pydicom-CT_small-openjpeg-cr20` | 1 | ~s | ~ | ~ | ~ | = | = | E | E | W69 |
| `gen-pydicom-CT_small-openjpeg-rev` | 0 | =s | = | = | = | = | = | E | E | =s |
| `gen-pydicom-MR_small-openjpeg-cr20` | 1 | ~s | ~ | ~ | ~ | = | = | E | E | W185 |
| `gen-pydicom-MR_small-openjpeg-rev` | 0 | =s | = | = | = | = | = | E | E | =s |
| `gen-synth-rgb8-60x40-openjpeg-cr20` | 1 | ~ | ~ | ~ | = | = | = | E | E | W12 |
| `gen-synth-rgb8-60x40-openjpeg-rev` | 0 | = | = | = | = | = | = | E | E | = |
| `gen-synth-s12-40x40-openjpeg-cr20` | 4096 | ~ | ~ | ~ | ~ | = | = | E | E | ~ |
| `gen-synth-s12-40x40-openjpeg-rev` | 0 | =s | = | = | = | = | = | E | E | =s |
| `gen-synth-s16-64x64-openjpeg-cr20` | 1 | ~s | ~ | ~ | ~ | = | = | E | E | W2520 |
| `gen-synth-s16-64x64-openjpeg-rev` | 0 | =s | = | = | = | = | = | E | E | =s |
| `gen-synth-u16-128x96-openjpeg-cr20` | 1 | ~ | ~ | ~ | ~ | = | = | E | E | W1816 |
| `gen-synth-u16-128x96-openjpeg-rev` | 0 | = | = | = | = | = | = | E | E | = |
| `gen-synth-u16-3frame-32x32-openjpeg-cr20` | 1 | W2 | W2 | W2 | ~ | = | = | E | E | W4708 |
| `gen-synth-u16-3frame-32x32-openjpeg-rev` | 0 | = | = | = | = | = | = | E | E | = |
| `gen-synth-u8-64x48-openjpeg-cr20` | 1 | ~ | ~ | ~ | = | = | = | E | E | W14 |
| `gen-synth-u8-64x48-openjpeg-rev` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-693_J2KI` | 1 | = | = | = | W843 | = | = | E | E | W843 |
| `pydicom-693_J2KR` | 0 | =s | = | = | = | = | = | E | E | =s |
| `pydicom-GDCMJ2K_TextGBR` | 0 | = | E | E | = | = | = | E | E | = |
| `pydicom-J2K_pixelrep_mismatch` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-JPEG2000` | 1 | ~s | ~ | ~ | = | = | = | E | E | W30 |
| `pydicom-JPEG2000-embedded-sequence-delimiter` |  | **ABORT** | **ABORT** | rej | rej | rej | rej | rej | rej | rej |
| `pydicom-MR2_J2KI` | 1 | ~ | ~ | ~ | ~ | = | = | E | E | W22 |
| `pydicom-MR2_J2KR` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-MR_small_jp2klossless` | 0 | =s | = | = | W1 | = | = | E | E | W1 |
| `pydicom-RG1_J2KI` | 1 | ~ | ~ | ~ | ~ | = | = | E | E | W327 |
| `pydicom-RG1_J2KR` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-RG3_J2KI` | 1 | ~ | ~ | ~ | ~ | = | = | E | E | W7 |
| `pydicom-RG3_J2KR` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-SC_rgb_gdcm_KY` | 1 | = | = | = | = | = | = | E | E | = |
| `pydicom-US1_J2KI` | 1 | ~ | ~ | ~ | ~ | = | = | E | E | W41 |
| `pydicom-US1_J2KR` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-emri_small_jpeg_2k_lossless` | 0 | = | = | = | W2 | = | = | E | E | W2 |
| `pydicom-examples_jpeg2k` | 0 | = | = | = | = | = | = | E | E | = |
| `pydicom-explicit_VR-UN` | 0 | =s | = | = | = | = | = | E | E | =s |
| **pass** | | **35/36** | **34/36** | **34/36** | **33/36** | **36/36** | **36/36** | **0/36** | **0/36** | **20/36** |

#### htj2k

| case | max_abs | hayro | oxideav | rustj2k | j2k | ojpure | openjp2 | openjph | ndic | dtk |
|---|---|---|---|---|---|---|---|---|---|---|
| `gen-synth-rgb8-60x40-openjph-q` | 1 | E | ~ | E | = | = | = | W225 | E | W225 |
| `gen-synth-rgb8-60x40-openjph-rev` | 0 | E | = | E | = | = | = | W255 | = | W255 |
| `gen-synth-rgb8-60x40-openjph-rev-rpcl` | 0 | E | = | E | = | = | = | W255 | = | W255 |
| `gen-synth-u12-65x31-openjph-q` | 1 | E | ~ | E | = | = | = | ~ | E | ~ |
| `gen-synth-u12-65x31-openjph-rev` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u12-65x31-openjph-rev-rpcl` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u16-128x96-openjph-q` | 1 | E | ~ | E | ~ | = | = | ~ | E | ~ |
| `gen-synth-u16-128x96-openjph-rev` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u16-128x96-openjph-rev-rpcl` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u16-3frame-32x32-openjph-q` | 2 | E | ~ | E | ~ | = | = | ~ | E | ~ |
| `gen-synth-u16-3frame-32x32-openjph-rev` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u16-3frame-32x32-openjph-rev-rpcl` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u8-1x1-openjph-q` | 1 | E | = | E | = | E | = | = | E | = |
| `gen-synth-u8-1x1-openjph-rev` | 0 | E | = | E | = | E | = | = | = | = |
| `gen-synth-u8-1x1-openjph-rev-rpcl` | 0 | E | = | E | = | E | = | = | = | = |
| `gen-synth-u8-64x48-openjph-q` | 1 | E | ~ | E | = | = | = | ~ | E | ~ |
| `gen-synth-u8-64x48-openjph-rev` | 0 | E | = | E | = | = | = | = | = | = |
| `gen-synth-u8-64x48-openjph-rev-rpcl` | 0 | E | = | E | = | = | = | = | = | = |
| `pydicom-HTJ2KLossless_08_RGB` | 0 | E | = | E | = | = | = | W186 | = | W186 |
| `pydicom-HTJ2K_08_RGB` | 1 | E | ~ | E | ~ | = | = | W162 | E | W162 |
| **pass** | | **0/20** | **20/20** | **0/20** | **20/20** | **17/20** | **20/20** | **15/20** | **13/20** | **15/20** |

`justjp2` (0/36: "encoded tile header truncated" on OpenJPEG output), `pure_jpeg2k` (2/36: only unsigned 16-bit) and `oxigdal-jpeg2000` (0/36: 8-bit output only, and it returns a grey image if headers are not parsed) are not usable; they are left out of the tables.

### Failures explained

**hayro: `gen-synth-u16-3frame-32x32-openjpeg-cr20`, W2.** Two pixels in frame 0 differ by 2 from the OpenJPEG oracle. oxideav and rust-j2k show the same difference, and the three independent decoders agree with each other within 1. This is 9/7 floating-point spread, not a bug; see [Rulings](#rulings-on-disputed-and-questioned-cases).

**hayro and oxideav: `pydicom-JPEG2000-embedded-sequence-delimiter`, ABORT.**
- Its extracted bytes declare Xsiz = 0xFEFFDDE0. Both crates try to allocate about 15 TB and abort, which is not a catchable panic. Hayro spends 16 s first.
- The wrapper must reject a SIZ that disagrees with the DICOM Rows, Columns and Samples per Pixel *before* calling the codec. With that check in place, the fuzz runs below found nothing.

**oxideav and rust-j2k: `pydicom-GDCMJ2K_TextGBR`, E.**
- This is the corpus's only multi-tile file: 16 tiles, 6 tile-parts each, RLCP, 6 layers, RCT, wrapped in JP2. The encoder wrote TNsot = 5 for 6 tile-parts. After the `jp2c` box comes one 0x00 byte, DICOM's even-length fragment padding, which j2k's JP2 parser reads as a truncated box until the wrapper unwraps the frame.
- OpenJPEG, hayro and j2k tolerate the wrong TNsot; oxideav (`InvalidTilePartIndex`) and rust-j2k reject the tile-part count.
- This matters only if oxideav is ever used for Part 1 (it is not recommended for that). It would be a one-line leniency fix upstream.

**j2k: `MR_small_jp2klossless` W1, `emri_small_jpeg_2k_lossless` W2, `693_J2KI` W843.**
- Off-by-1 or 2 errors on 25–80 % of the pixels of 16-bit *lossless* frames. Errors on every pixel of a 3-layer 5/3 file.
- The same in its f32 and native-integer output paths.
- Its upstream, hayro, decodes all three exactly, so this is a regression in the fork. It rules j2k out for Part 1, and lowers trust in its shared pipeline for HTJ2K.

**openjph-core (and `dicom-toolkit-jpeg2000`, which uses it for HT):**
- Wrong on every 3-component file (W162–W255). The inverse colour transform is broken; single-component files pass.
- The fuzz run below found panics.

**openjpeg2-pure-rs:** fails the three 1×1 HTJ2K files (`DecodeFailed`).

**ndic:** refuses 9/7, multiple tiles and multiple layers, by design.

### Speed

Wall time per frame, including process start, on one core of the same machine (seconds):

| Case | hayro | j2k | openjp2 | ojpure | oxideav | rust-j2k | openjph |
|---|---|---|---|---|---|---|---|
| `RG1_J2KR` 1955×1841 16-bit lossless | 0.65 | 0.18 | 0.59 | 0.64 | 3.98 | 1.28 | – |
| `RG1_J2KI` lossy | 0.15 | 0.12 | 0.15 | 0.17 | 2.89 | 0.53 | – |
| `MR2_J2KR` 1024×1024 | 0.13 | 0.06 | 0.12 | 0.12 | 1.05 | 0.28 | – |
| `US1_J2KR` 640×480 RGB | 0.09 | 0.04 | 0.04 | 0.07 | 0.61 | 0.16 | – |
| `HTJ2KLossless_08_RGB` 640×480 | – | 0.04 | 0.02 | 0.02 | 0.92 | – | 0.03 |
| `HTJ2K_08_RGB` 640×480 | – | 0.04 | 0.02 | 0.02 | 0.76 | – | 0.04 |

Stripped `wasm32-unknown-unknown` adapter sizes: hayro 266 KB, oxideav 304 KB, ojpure 324 KB, rust-j2k 203 KB, openjph 153 KB.

### Fuzzing

`fuzz.py` mutates corpus codestreams: bit flips, interesting bytes and words, truncation, chunk duplication and deletion, biased towards the header. It runs each mutant in a fresh process with a 10 s timeout and a 4 GiB address-space limit.

Mutants whose SIZ width, height or component count differ from the seed are skipped, because the wrapper rejects those (see the ABORT above). Without that check, hayro and oxideav abort on a huge SIZ.

Each run lasted 5 minutes; a second number is a second run with another seed and input set.

| Candidate | Execs | Panics | Aborts | Timeouts | Signals |
|---|---|---|---|---|---|
| hayro (J2K seeds) | 17,575 + 25,640 | 0 | 0 | 0 | 0 |
| oxideav (all; HT only; J2K only) | 6,849 + 47,070 + 5,248 | 0 | 0 | 0 | 0 |
| j2k (all; HT only) | 23,281 + 54,924 | 0 | 0 | 0 | 0 |
| rust-j2k (J2K) | 12,278 | 0 | 0 | 0 | 0 |
| openjpeg2-pure-rs (all) | 22,899 | 0 | 0 | 0 | 0 |
| openjp2 (all) | 21,989 | 0 | 0 | 0 | 0 |
| openjph-core (HT) | 30,759 | **112** (`params/local.rs:1474`, index out of bounds) | **12** (allocation failure) | 0 | 0 |

Reproducers are in `codecs/survey-j2k/fuzz-findings/openjph/`.

This is a smoke test, not coverage-guided fuzzing. Phase 2 must still run `cargo fuzz` for at least 10 minutes per crate, as AGENTS.md requires.

### Readability

- **hayro**: 9.5 k lines of decoder only, in 26 files named after pipeline stages:
  - `codestream.rs`, `progression.rs`, `segment.rs`, `arithmetic_decoder.rs`, `bitplane.rs`, `idwt.rs`, `tile.rs`;
  - 30 `unwrap`/`expect`/`panic!` in non-test code.

  Compact, idiomatic, and the easiest of the field to patch. It works in f32 throughout, which is exact for 5/3 at DICOM bit depths: all 16-bit lossless cases are exact.
- **oxideav**: 37 k non-test lines, of which about 7 k are generated HT tables and about 5 k are encoder. Every function cites T.800/T.814 clauses (`§D.3.3`, Table D.1), and there are only 23 non-test `unwrap`/`panic!`. Easy to follow against the standard, but large. Speed comes from straightforward per-coefficient structs, not from algorithmic problems.
- **rust-j2k**: clean, dependency-free, 11 k lines; no HTJ2K and no JP2.
- **j2k**: 80 k non-test lines across 440 files, with GPU planning layers. Hard to audit, and 1,192 non-test `unwrap`/`expect`.
- **openjp2, openjpeg2-pure-rs**: C translated to Rust with raw pointers. They match OpenJPEG bit-for-bit on the whole corpus, but are not code we could safely fix.

## Rulings on disputed and questioned cases

All three disputed jpeg2000 cases have the same cause, and **the oracle is correct in each**. The `openjpeg-cli` reference in `scripts/ref_decode.py` runs `opj_decompress -o x.rawl`. It then reads the samples as `<i2` without sign extension. For a signed component of precision p < 16, `opj_decompress` writes the p-bit two's-complement bit pattern, so every negative sample comes back 2^p too large. For the unsigned-SIZ case, the harness also skips CONTRACT's sign extension from Bits Stored. Running `opj_decompress` directly confirms it: `cli − oracle` takes only the values {0, 2^p}.

| Case | SIZ | DICOM | openjpeg-cli − oracle | Independent decoders matching the oracle | Ruling |
|---|---|---|---|---|---|
| `gen-synth-s12-40x40-openjpeg-rev` | signed, 12-bit | BS 12, PR 1 | {0, 4096} | oxideav, rust-j2k, hayro (with sign fix), j2k, openjp2, ojpure; the oracle is the seed | Oracle correct. Expected output is the seed. |
| `pydicom-693_J2KR` | signed, 14-bit | BS 16, PR 1 | {0, 16384} | all six | Oracle correct. Decode as signed 14-bit (range −2000…2492), which fits in BS 16 unchanged. SIZ precision < Bits Stored is legal. |
| `pydicom-J2K_pixelrep_mismatch` | **unsigned**, 13-bit | BS 13, **PR 1** | {0, 8192} | all six | Oracle correct. Pixel Representation governs, as FORMAT.md says. Take the codestream's 13-bit sample values as stored bits and sign-extend from bit 12 (CONTRACT normalisation). The result is a plausible CT range of −2000…1896, with −2000 as padding. Do **not** apply a signed DC shift. Decode as SIZ says, then reinterpret. |

The decoders count as independent because oxideav, rust-j2k and hayro share no code with OpenJPEG or with each other. j2k is a hayro fork.

**Requested from the coordinator** (shared files):

1. In `ref_decode._from_openjpeg_cli`:
   - sign-extend each signed component from its SIZ precision;
   - then apply the CONTRACT mask or sign-extension to Bits Stored.

   With that change the references agree, and the three cases stop being disputed.
2. `gen-synth-u16-3frame-32x32-openjpeg-cr20`: raise `max_abs` from 1 to 2.
   - hayro, oxideav and rust-j2k all differ from OpenJPEG by 2 on two pixels of frame 0.
   - They agree with each other within 1.
   - CONTRACT sets lossy `max_abs` at "at least the largest disagreement between reference decoders". Here the only references were OpenJPEG-family, so they never disagreed.
   - The HTJ2K twin of this case already has `max_abs` 2.

## Corpus gaps found

- **jpeg2000:**
  - Progression orders: only LRCP, plus RLCP in the GDCM file. There is no RPCL, PCRL or CPRL.
  - No explicit precincts.
  - No code-block style flags (BYPASS, RESET, TERMALL, VCAUSAL, PTERM, SEGSYM).
  - One multi-tile file. NL is always 5, and code-blocks are 64×64 everywhere except GDCM's 32×32.
  - Multiple layers only in `693_J2KI` (3) and GDCM (6).
- **htj2k:** only RPCL, single tile, single layer, unsigned, HTONLY. There is no signed input, no MIXED code-blocks, no 12- or 16-bit real-world file, and no multi-tile file.

Phase 2 agents should add these through `generate.py`; ask the coordinator if it can't express them. Useful tools:

- `opj_compress` options `-p RPCL|PCRL|CPRL`, `-c`, `-M 1..63`, `-t`, `-n 1|2|8`, `-r` (multiple rates), `-TP R`;
- `ojph_compress` on signed raw input, with `-tile_size` and `-prog_order`.

## Phase 2 plan

```
Phase 2  adopt; the two agents run in parallel and share nothing
            ├─ jpeg2000   shl-codec-jpeg2000 wraps hayro-jpeg2000
            └─ htj2k      shl-codec-htj2k wraps oxideav-jpeg2000
            │
Phase 2b only if the HTJ2K speed gate fails (see htj2k step 6)
            └─ htj2k      HT block decoder of our own, driven by hayro's tier-2/DWT pipeline
```

### jpeg2000 agent (`shl-codec-jpeg2000`)

1. **Dependency:** `hayro-jpeg2000 = { version = "0.4", default-features = false, features = ["std", "simd"] }`. Drop `image`/`moxcms`. Keep `simd` unless the phase-3 audit wants zero transitive `unsafe`; then drop it too, at some cost in speed.
2. **Before calling hayro**, in `decode_frame`:
   - Strip a JP2 wrapper yourself. Find `jp2c` and take the payload to the end of the buffer, so the DICOM pad byte after the box is ignored. This keeps hayro's JP2 colour (sYCC, palette, `cdef`) handling out of DICOM decoding.
   - Parse SIZ with a small reader of your own (about 60 lines, as in `survey-j2k/common/src/lib.rs`).
   - Refuse with `Invalid` unless all of these hold:
     - width = Columns, height = Rows, Csiz = Samples per Pixel;
     - all components have the same precision, and precision ≤ Bits Allocated;
     - XRsiz = YRsiz = 1.

   These checks stop the 15 TB allocation abort.
3. **After decoding:** for each component, `round()` the f32 samples. If the SIZ sign bit is set, subtract 2^(p−1). Clamp to the SIZ range and write Bits Allocated little-endian. Report RGB when Csiz = 3 (hayro applies RCT/ICT itself when COD's MCT flag is set).
4. **Errors:** map hayro's `DecodeError` to our errors. `UnsupportedFeature`-type variants become `Unsupported` (exit 3); everything else becomes `Invalid` (exit 2).
5. **Rulings and tolerances:** copy the [rulings](#rulings-on-disputed-and-questioned-cases) into FORMAT.md Rulings, and confirm both coordinator requests are applied.
6. **Corpus gaps:** add the [gap cases](#corpus-gaps-found) and run check.py.
   - A failure in hayro: write a minimal reproducer and patch upstream (LaurenzV/hayro; responsive, 30 contributors). If a fix is urgent, vendor the patch with `[patch.crates-io]` in our crate only.
   - Also offer upstream a PR exposing per-component signedness, which would remove the SIZ sign handling from step 3.
7. **Fuzz** at least 10 minutes with `cargo fuzz` on `decode_frame`, using the corpus frames as seeds.
   - Use `openjpeg2-pure-rs` as a **differential oracle** in the fuzz target (dev-dependency only, never shipped). It matched OpenJPEG on 36/36 files. When it decodes a mutant successfully, compare its output with ours.

### htj2k agent (`shl-codec-htj2k`)

1. **Dependency:** `oxideav-jpeg2000 = { version = "0.0.17", default-features = false }`, pinned exactly, because 0.0.x releases may break the API. No transitive dependencies.
2. **SIZ validation and JP2 (JPH) unwrap**, the same as jpeg2000 steps 1–2.
3. **Decoding:** call `oxideav_jpeg2000::decode_j2k(&bytes)`. It returns `DecodedImage { components: Vec<DecodedComponent { samples: Vec<i32>, is_signed, precision_bits, .. }> }` with RCT/ICT applied and signed samples already signed. No sign fix is needed. Clamp to the SIZ range and write.
4. **Don't dispatch on CAP.** oxideav decodes Part 1 code-blocks too (HTDECLARED and MIXED sets), so a `.201`–`.203` file whose codestream has no HT blocks still decodes.
5. **Corpus:** add the [gap cases](#corpus-gaps-found):
   - signed, 12- and 16-bit lossy;
   - multi-tile;
   - MIXED, if an encoder that writes it is available;
   - LRCP/CPRL under `.201`/`.203`.

   Fix any failures upstream (OxideAV/oxideav-jpeg2000, active), or with a `[patch.crates-io]` in our crate.
6. **Speed gate:** build for `wasm32-unknown-unknown` and time `pydicom-HTJ2KLossless_08_RGB` and a 512×512 16-bit case. The budget is for the coordinator to set; a suggestion is that a 512×512 16-bit frame should decode in under 150 ms in a browser.
   - Natively oxideav takes 0.9 s for 640×480 RGB, against about 0.03 s for OpenJPH-class decoders.
   - If it misses the budget, first check whether oxideav's pending performance work (its issue opened 2026-10-11) closes the gap. Otherwise go to phase 2b.
7. **Fuzz** at least 10 minutes with `cargo fuzz`.

### Phase 2b: HT block decoder (contingency)

- **Owner:** the htj2k agent, working with the jpeg2000 agent.
- **Code to build:**
  - an HT block decoder: about 1.5 k lines plus tables;
  - CAP and CPF marker parsing;
  - the tier-2 changes for HT code-blocks: the pass count is cleanup plus an optional SigProp/MagRef pair, and segment lengths are split across the two coding-pass groups. About 300 lines.
- **Where it lives:**
  - preferably as an upstream contribution to hayro, which has an open issue asking for HTJ2K (2026-02-05);
  - otherwise in a fork vendored in `shl-codec-jpeg2000`, which `shl-codec-htj2k` then calls.
- **Code to study:**
  - `ndic-htj2k` `block.rs` (MIT): a faithful, differentially tested port of OpenJPH's 32-bit block decoder;
  - `oxideav-jpeg2000` `ht.rs` and `ht_tables.rs` (MIT): annotated with T.814 clauses;
  - the j2k crate: the same hayro integration already done once, to see where the hooks go. Don't copy its pipeline changes; that crate has lossless regressions.
- **Interface to fix first:** the code-block decode signature that hayro's `bitplane.rs` already implies. Its inputs are:
  - the code-block's coded segments and the number of coding passes;
  - missing MSBs (zero bit-planes);
  - sub-band orientation;
  - code-block width and height;
  - the style flags.

  It returns sign-magnitude coefficients in a w×h buffer. The jpeg2000 agent owns that signature. The HT decoder implements it and is unit-tested against `ndic-htj2k` on random blocks.

## Build estimate (contingency)

This applies only if both adoptions fail. A full Part 1 + Part 15 decoder, with `#![forbid(unsafe_code)]`:

| Module | Spec | Size | Depends on |
|---|---|---|---|
| Codestream and markers: SIZ, COD/COC, QCD/QCC, RGN, POC, TLM/PLT/PPM/PPT, SOT/SOD, CAP/CPF; tile-part assembly | T.800 Annex A, T.814 A | ~1.5 k lines | – |
| Geometry: tile-component, resolution, sub-band, precinct and code-block partitions | B.5–B.7 | ~0.6 k | markers |
| Tier-2: packet headers, tag trees, Lblock, five progression orders plus POC | B.9–B.12 | ~1.2 k | geometry |
| MQ decoder | Annex C | ~0.2 k | – |
| EBCOT tier-1: three passes, contexts, all code-block styles | Annex D | ~1.2 k | MQ |
| HT block decoder: MEL, VLC, UVLC, MagSgn, SigProp, MagRef | T.814 clause 7 | ~1.5 k + tables | – |
| Dequantisation, ROI maxshift | Annex E, H | ~0.2 k | – |
| IDWT 5/3 integer and 9/7 float, boundary extension, NL 0–32 | Annex F | ~0.6 k | – |
| MCT (RCT/ICT), DC level shift, clamp, output | Annex G | ~0.2 k | – |

The total is about 7–8 k lines, the size of hayro.

**Order of work:**
1. Markers, then geometry, then tier-2. This is serial, and fixes the code-block interface above.
2. Then four parallel strands:
   - MQ + EBCOT;
   - HT block decoder;
   - IDWT + MCT + output;
   - corpus additions.

   These can start once two interfaces are fixed: the code-block signature, and `fn idwt(subbands: &TileComponentBands, kernel, levels) -> Vec<i32 or f32>`.

**Code to study:**
- hayro, for the structure; its licence permits copying with attribution;
- oxideav, for spec-annotated detail;
- `ndic-htj2k`, for the HT block decoder.

We don't expect to need this: hayro already provides the result such a build would aim for.

## Files

`codecs/survey-j2k/` holds:

- `common/`: the adapter protocol and SIZ reader;
- `adapters/<crate>/`: one binary per candidate;
- `wasmcheck/`: the openjp2 wasm link test;
- `score.py`, `fuzz.py`;
- `results-jpeg2000.{json,txt}`, `results-htj2k.{json,txt}`;
- `fuzzlogs/`, `fuzz-findings/`.

The workspace has its own `[workspace]` table and its own `target/`.
