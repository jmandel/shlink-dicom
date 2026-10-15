# htj2k

**Crate:** `shl-codec-htj2k` (uses `shl_codec_jpeg2000::prep` for header checks and output)

**Specifications:** ITU-T T.814 | ISO/IEC 15444-15 (High-Throughput block coder inside the Part 1 framework); DICOM transfer syntaxes 1.2.840.10008.1.2.4.201/.202/.203

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.4.201` | 7 |
| `1.2.840.10008.1.2.4.202` | 6 |
| `1.2.840.10008.1.2.4.203` | 7 |

Sources: generated 18, pydicom 2. Multi-frame cases: 3. Ground truth from seeds: 12.

## Traps

- Needs the whole JPEG 2000 framework (codestream, tier-2, DWT, MCT); only the block decoder differs (cleanup, SigProp and MagRef passes).
- `.202` requires RPCL progression; `.201` and `.202` are lossless only.
- Corpus gap: the cases are mostly OpenJPH output from unsigned synthetic seeds, plus two pydicom 8-bit RGB files. Signed and 12/16-bit real-world HTJ2K are missing. Phase 2 added signed and tiled cases ([STATUS](#new-cases-extragen_casespy)). The installed `ojph_compress` mishandles signed raw input, so signed cases are built as [Rulings](#signed-htj2k-cases-how-they-were-made) describes.

## Candidate crates

`openjph-core` (a port of OpenJPH), `oxideav-jpeg2000`, `j2k`, `ndic-htj2k`, `openjpeg2-pure-rs`. Evaluated in phase 1 by the j2k-survey agent.

## Decision

**Wrap `oxideav-jpeg2000` 0.0.17, vendored with two speed patches** ([Phase 2c](#phase-2c-speed)). The wrapper was decided by the phase 1 j2k-survey; the full evidence is in [../jpeg2000/SURVEY.md](../jpeg2000/SURVEY.md). This crate stays separate from `shl-codec-jpeg2000`.

**Evidence:**
- Pure Rust, no `unsafe`, zero dependencies with `default-features = false`, MIT, and builds for wasm32.
- Spec-annotated code, written from T.800/T.814.
- Corpus: 20/20, with signed output handled natively.
- No panics, aborts or hangs in 59 k mutation-fuzz executions, once SIZ is validated first.
- It also decodes Part 1 code-blocks, so `.201`–`.203` files without HT blocks still decode.

**Gaps:**
- Speed, as released: 0.9 s natively for a 640×480 RGB frame, against 0.03 s for OpenJPH-class decoders. Two patches fixed this ([Phase 2c](#phase-2c-speed)).
- One maintainer, and a 0.0.x version.
- The same SIZ allocation abort as hayro, so the wrapper validates SIZ first.

The plan sets a wasm speed gate, with a contingency if it fails: an HT block decoder of our own, studied from `ndic-htj2k`, plugged into hayro's pipeline.

**Rejected:**
- `j2k`: 20/20 and fast, but its shared pipeline has lossless Part 1 regressions; MSRV 1.99.
- `openjph-core`: inverse colour transform wrong on every 3-component file, and 112 fuzz panics. `dicom-toolkit-jpeg2000` inherits both through it.
- `openjpeg2-pure-rs`: fails the 1×1 images, and has 228 `unsafe`.
- `openjp2`: no wasm32.
- `ndic`: reversible, single-tile only.

**The plan:** see [SURVEY.md, Phase 2 plan](../jpeg2000/SURVEY.md#phase-2-plan).

**Phase 2 outcome.** `shl-codec-htj2k` wraps `oxideav-jpeg2000` =0.0.17 (`default-features = false`, no dependencies). Before oxideav sees a frame, it runs the same checks as the JPEG 2000 wrapper: `shl_codec_jpeg2000::prep::prepare` strips JP2/JPH wrappers and checks the main header against the data set. Output goes through the same `prep::pack`, so the rules for sign, colour and subsampled chroma are the JPEG 2000 ones ([jpeg2000 Rulings](../jpeg2000/FORMAT.md#rulings)). oxideav returns signed samples already signed, with RCT/ICT undone, and each component on its own grid. The wrapper does not dispatch on CAP.

The corpus passed, but the speed gate failed by about 4×: 652 ms in wasm32 for a 512×512 16-bit frame, against a 150 ms budget.

### Phase 2c: speed

The coordinator's plan was to try the cheapest fix first: vendor oxideav and fix its two hot spots (option A). Only if that missed the budget would we build an HT block decoder inside the vendored hayro (option B). Option A met the budget, so option B was not started.

`codecs/shl-codec-htj2k/vendor/oxideav-jpeg2000` is crates.io 0.0.17 with two patches. The [vendor README](../../../codecs/shl-codec-htj2k/vendor/README.md) gives each patch and its reason, and `vendor/oxideav-jpeg2000-0.0.17-shl.patch` holds the diff:
1. **Reassembly.** The per-coefficient `Nb(u, v)` source is resolved once per code-block. Before, it was resolved per coefficient, and each call scanned the whole block (`max_decoded_bits`), which is quadratic in the block size.
2. **CxtVLC.** Codewords are looked up in an index built at compile time from the spec tables. Before, the whole table was searched linearly after every bit.

Both patches change speed only. On 2,320 inputs (corpus frames and the fuzz corpus), the patched crate gives byte-identical samples, or the identical error, to crates.io 0.0.17. The 512×512 16-bit frame now takes **30 ms in wasm32** (budget 150 ms), 21× faster than before. Timings for every step are in [PERF.md](PERF.md).

## Rulings

### Signed HTJ2K cases: how they were made

The survey listed signed input as a gap. The `ojph_compress` installed here mishandles signed samples:
- with `-signed true`, raw samples are read as unsigned and clipped (−2048 comes back as 2047);
- TIFF int16 input is coded with an *unsigned* 16-bit SIZ.

So `extra/gen_cases.py` (through `../jpeg2000/extra/j2k_gen.py`) encodes a signed frame as offset-binary unsigned samples, v + 2^(p−1). ojph's DC level shift turns them back into v before the wavelet transform. The helper then sets the sign bit of every SIZ Ssiz. The coded data is then what a signed encoder writes, because signedness only decides whether the decoder applies the DC level shift (T.800 Annex G.1.2). OpenJPEG (through pylibjpeg) reproduces the seed exactly on all three signed lossless cases, and these cases are not disputed.

The `openjph` reference cannot check them (PNM output carries no signed samples). So the signed lossless cases rest on the seed plus OpenJPEG, and the two signed lossy ones on OpenJPEG alone (WEAK).

### Other rulings

The JPEG 2000 rulings on [sign handling](../jpeg2000/FORMAT.md#sign-handling), [colour](../jpeg2000/FORMAT.md#colour-of-three-component-frames), [Planar Configuration](../jpeg2000/FORMAT.md#planar-configuration-ext-gdcm-hardcopycolor_ybr_rct_j2k_pc1) and [precision above Bits Stored](../jpeg2000/FORMAT.md#precision-above-bits-stored-ext-gdcm-osirix10vs8bitsstored) apply here unchanged, through the shared `prep` module. No HTJ2K case is disputed.

## STATUS

Phase 2c (speed), 2026-10-14.

### check.py

**htj2k: 40/40 pass** (all `expect=decode`; none disputed), with the command in [jpeg2000 STATUS](../jpeg2000/FORMAT.md#checkpy). jpeg2000 still passes 166/166 with the same build. By source:

| Source | Cases |
|---|---|
| generated by `generate.py` | 23 |
| generated by this agent | 13 |
| pydicom | 2 |
| external | 2 |

### New cases: `extra/gen_cases.py`

The 11 cases are made with `ojph_compress` from raw seed samples (signed ones as described in [Rulings](#signed-htj2k-cases-how-they-were-made)) and registered with `generate.register`; the oracle comes from `scripts/oracle.py --format htj2k`.

| Case (`gen-<seed>-…`) | Covers |
|---|---|
| `synth-s16-64x64-ojph-rev-signed` (.201) | signed 16-bit, lossless |
| `synth-s12-40x40-ojph-rev-signed-lrcp` (.201) | signed 12-bit, LRCP |
| `pydicom-CT_small-ojph-rev-rpcl-signed` (.202) | signed 16-bit CT, RPCL |
| `synth-s16-64x64-ojph-q-signed-cprl` (.203) | signed 16-bit lossy, CPRL |
| `synth-s12-40x40-ojph-q-signed-tiles` (.203) | signed 12-bit lossy, 9 tiles |
| `synth-u16-128x96-ojph-rev-tiles-lrcp` (.201) | 4 tiles, LRCP |
| `synth-u16-128x96-ojph-rev-rpcl-tiles-tp` (.202) | 12 tiles, tile-parts per resolution, TLM |
| `synth-u12-65x31-ojph-rev-pcrl-cb16` (.201) | odd size, PCRL, 16×16 code-blocks |
| `synth-rgb8-60x40-ojph-q-cprl-tiles-prec` (.203) | RGB, CPRL, tiles, precincts, 16×16 code-blocks |
| `local-mri-slice-ojph-rev-rpcl-tiles` (.202) | real 16-bit MR, 4 tiles |
| `synth-u16-3frame-32x32-ojph-q-rlcp-tiles` (.203) | RLCP, tiles, 3 frames |

### MIXED cases: `extra/gen_mixed.py`

In a MIXED tile-component (T.814 §A.4, Ccap15 bits 15–14 = `11`), each code-block is either an HT block or a Part 1 (MQ) block, with no flag saying which. Kakadu is not installed and `ojph_compress` writes HT-only, but the vendored oxideav has a MIXED encoder. `shl-codec-htj2k`'s `encode_mixed` example uses it: lossless 5/3, one layer, RPCL. The encoder codes every block both ways and keeps the HT coding unless the MQ coding is markedly smaller.

| Case | Covers | HT / Part 1 blocks |
|---|---|---|
| `gen-pydicom-CT_small-oxideav-rev-mixed` (.201) | signed 16-bit CT | 13 / 3 |
| `gen-synth-rgb8-60x40-oxideav-rev-mixed` (.202) | RGB with RCT | 10 / 38 |

The block counts come from a decoder instrumented outside the tree.

**What these cases show, and what they don't.** Neither reference decoder reads MIXED: OpenJPEG 2.5 stops with "Unsupported Mixed HT code-block style found", and OpenJPH with "wrong settings in a COD-SPcod parameter". So the oracle is the seed alone (truth = seed, lossless, `families agreeing: []`), and the encoder and decoder are the same library. The cases check that MIXED streams decode exactly and guard against regressions. They do not show that oxideav reads MIXED the way Kakadu writes it. The upstream evidence for that is oxideav's own test, `tests/mixed_conformance.rs`. It decodes the three Kakadu-made MIXED streams of the ISO/IEC 15444-4 conformance set. Two of them carry the same lossless components, and those decode byte-identically. That test passes with our patches applied. Those streams have four sub-sampled components, which DICOM cannot carry, so they are not in the corpus.

### Robustness

- **Header checks:** the same as JPEG 2000 (shared `prep`, [jpeg2000 STATUS](../jpeg2000/FORMAT.md#robustness)). The wrapper also checks that oxideav's output planes have the sizes SIZ implies.
- **Fuzzing:** `cargo fuzz` in `codecs/shl-codec-htj2k/fuzz`, with the same target design as JPEG 2000. The seeds are the HTJ2K frames plus JPEG 2000 frames, since oxideav decodes Part 1 too.

  | Run | Execs | Crashes | Timeouts | OOMs |
  |---|---|---|---|---|
  | 1 (10 min, 4 workers) | 663,249 | 0 | 0 | 0 |
  | 2 (10 min, 4 workers, with the new cases and JPEG 2000 frames as seeds) | 61,380 | 0 | 0 | 0 |

  | 3 (10 min, 4 workers, after the speed patches) | 271,655 | 0 | 0 | 0 |
  | 4 (10 min, 4 workers, MIXED frames added as seeds; coverage 3,438 → 3,589 edges) | 424,989 | 0 | 0 | 0 |

  Runs 1 and 2 used the as-released oxideav. Run 2 had fewer executions because the larger Part 1 seeds decode slowly in oxideav.
- **Differential check** of the speed patches: see [PERF.md, Exactness](PERF.md#exactness).
- **Checks:** all clean:
  - `cargo test` for `shl-codec-htj2k` and the vendored `oxideav-jpeg2000` (839 unit tests);
  - `cargo clippy -p shl-codec-htj2k -p oxideav-jpeg2000 -p shl-codec-jpeg2000 --all-targets -- -D warnings`;
  - the wasm32 build.

### Speed

**The gate passes:** a 512×512 16-bit frame takes 30 ms in wasm32 (budget 150 ms), against 621 ms before the patches. The other frames:

| Frame | native | wasm32 | before, wasm32 |
|---|---|---|---|
| 512×512 16-bit lossless | 22 ms | **30 ms** | 621 ms |
| 512×512 16-bit lossy (9/7) | 22 ms | 29 ms | 627 ms |
| 640×480 RGB (`HTJ2KLossless_08_RGB`) | 75 ms | 86 ms | 2,053 ms |
| 2048×2048 16-bit lossless | 435 ms | 540 ms | 10,113 ms |

Method, each step and the JPEG 2000 comparison: [PERF.md](PERF.md). JPEG 2000 (hayro) timings did not move.

### Known gaps

- MIXED code-blocks are covered only by streams from oxideav's own encoder, which no reference decoder reads ([MIXED cases](#mixed-cases-extragen_mixedpy)).
- Part 1 code-blocks in HTJ2K files go through oxideav's MQ decoder: 166 ms for 512×512 16-bit in wasm32, against hayro's 63 ms on .90/.91.
- The vendored oxideav carries two patches not yet offered upstream ([vendor README](../../../codecs/shl-codec-htj2k/vendor/README.md)).
- The `openjph` reference cannot check signed cases, so the signed lossy cases have a single reference (OpenJPEG).
- The JPEG 2000 gaps on POC, tile-level MCT and subsampling ([jpeg2000 Known gaps](../jpeg2000/FORMAT.md#known-gaps)) apply here, except that oxideav supports POC and Maxshift RGN.
