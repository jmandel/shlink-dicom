# htj2k

**Crates:** `shl-codec-htj2k`, which calls `shl-codec-jpeg2000`; the decoder is `shl-jpeg2000`

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
- Corpus gap: the cases are mostly OpenJPH output from unsigned synthetic seeds, plus two pydicom 8-bit RGB files. Signed and 12/16-bit real-world HTJ2K are missing. `extra/gen_cases.py` adds signed and tiled cases ([STATUS](#new-cases-extragen_casespy)). The installed `ojph_compress` mishandles signed raw input, so signed cases are built as [Rulings](#signed-htj2k-cases-how-they-were-made) describes.

## Decoder

HTJ2K codestreams are JPEG 2000 codestreams whose code-blocks use the HT block coder, so they are decoded by the same decoder as JPEG 2000, `shl-jpeg2000` ([jpeg2000 FORMAT.md, Decoder](../jpeg2000/FORMAT.md#decoder)). `shl-codec-htj2k` calls `shl-codec-jpeg2000`, so the header checks and the output rules for sign, colour and subsampled chroma are the JPEG 2000 ones ([jpeg2000 Rulings](../jpeg2000/FORMAT.md#rulings)). The wrapper does not dispatch on CAP: the decoder follows the codestream's own signalling, so a `.90`/`.91` file with HT code-blocks also decodes.

**Which code-blocks are HT** (T.814 A.3.2, A.4): the CAP marker's Ccap15 field. HTONLY (bits 15–14 `00`): every code-block. HTDECLARED (`10`), or no CAP: the tile-component's SPcod/SPcoc bit 6. MIXED (`11`): bit 6 alone means HT, bits 6 and 7 together mean each code-block is HT or Part 1.

**Tier-2** (T.814 Annex B): an HT code-block's passes are placeholder passes in whole triples, then HT sets of cleanup, SigProp and MagRef. Codeword segments end at each cleanup pass and after each MagRef pass; the placeholder passes join the first cleanup segment, which is found as the first contribution whose first length is at least 2. A code-block may carry several HT sets (one per quality layer, say); the last set whose cleanup segment is present is decoded, with S_blk counting the placeholder triples and the skipped sets.

**MIXED tile-components.** Nothing in the codestream says whether a MIXED code-block is HT or Part 1, and the two codings read their segment lengths differently only when a contribution crosses an HT segment boundary. Where they agree, the code-block stays undecided and tier-1 tries HT first, then Part 1 (the T.814 A.4 NOTE). Where they differ, the HT reading is tried first, and a failure later in the tile makes the decoder try the other reading, depth first (at most 64 attempts per tile; every stream seen so far needs one). The T.814 A.4 constraints on an HT block's first non-zero length (top bit 0, Lblock above 3) and a cleanup length of 1 rule out the HT reading.

**The HT block decoder** (`src/ht/`) is written from T.814 clause 7: the cleanup pass (MEL, the CxtVLC and U-VLC codes, MagSgn), SigProp and MagRef, including vertically causal mode. The CxtVLC tables in `src/ht/annex_c.rs` are taken from Annex C of the standard by `src/ht/gen_annex_c.py`, which checks that each context's code is prefix-free, complete and at most 7 bits long; the lookup tables are built from them at compile time.

**How it is checked:**
- the corpus ([STATUS](#status));
- `codecs/shl-jpeg2000/tests/ht_golden.rs`: 209 block decoder calls (random blocks of every size class and precision with SigProp and MagRef bytes, damaged blocks, random segments) against stored results of an independent block decoder, `ndic-htj2k` 0.2.5's port of OpenJPH's;
- the MIXED, refinement-pass and multiple-HT-set streams below;
- fuzzing ([Robustness](#robustness)).

## Rulings

### Signed HTJ2K cases: how they were made

Signed input was a corpus gap. The `ojph_compress` installed here mishandles signed samples:
- with `-signed true`, raw samples are read as unsigned and clipped (−2048 comes back as 2047);
- TIFF int16 input is coded with an *unsigned* 16-bit SIZ.

So `extra/gen_cases.py` (through `../jpeg2000/extra/j2k_gen.py`) encodes a signed frame as offset-binary unsigned samples, v + 2^(p−1). ojph's DC level shift turns them back into v before the wavelet transform. The helper then sets the sign bit of every SIZ Ssiz. The coded data is then what a signed encoder writes, because signedness only decides whether the decoder applies the DC level shift (T.800 Annex G.1.2). OpenJPEG (through pylibjpeg) reproduces the seed exactly on all three signed lossless cases, and these cases are not disputed.

The `openjph` reference cannot check them (PNM output carries no signed samples). So the signed lossless cases rest on the seed plus OpenJPEG, and the two signed lossy ones on OpenJPEG alone (WEAK).

### Other rulings

The JPEG 2000 rulings on [sign handling](../jpeg2000/FORMAT.md#sign-handling), [colour](../jpeg2000/FORMAT.md#colour-of-three-component-frames), [Planar Configuration](../jpeg2000/FORMAT.md#planar-configuration-ext-gdcm-hardcopycolor_ybr_rct_j2k_pc1) and [precision above Bits Stored](../jpeg2000/FORMAT.md#precision-above-bits-stored-ext-gdcm-osirix10vs8bitsstored) apply here unchanged, through the shared `prep` module. No HTJ2K case is disputed.

## STATUS

2026-10-16, with `shl-jpeg2000`.

### check.py

**htj2k: 42/42 pass** (all `expect=decode`; none disputed), with the command in [jpeg2000 STATUS](../jpeg2000/FORMAT.md#checkpy). jpeg2000 passes 177/177 with the same build. By source:

| Source | Cases |
|---|---|
| generated by `generate.py` | 23 |
| generated by `extra/gen_cases.py` | 11 |
| generated by `extra/gen_oxideav.py` | 4 |
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

### Cases from the oxideav encoder: `extra/gen_oxideav.py`

`ojph_compress` writes cleanup passes only, in HT-only codestreams, and Kakadu is not installed. The `oxideav-jpeg2000` 0.0.17 encoder writes two kinds of stream ojph cannot; its codestreams are stored in `extra/oxideav/` (lossless 5/3, one layer, RPCL, RCT for colour), and the script wraps them.
- **MIXED** (T.814 §A.4, Ccap15 bits 15–14 = `11`): each code-block is either an HT block or a Part 1 (MQ) block, with no flag saying which. The encoder coded every block both ways and kept the HT coding unless the MQ coding was markedly smaller.
- **Refinement passes:** HT blocks with SigProp and MagRef passes (three passes per block).

| Case | Covers | Blocks |
|---|---|---|
| `gen-pydicom-CT_small-oxideav-rev-mixed` (.201) | MIXED, signed 16-bit CT | 13 HT, 3 Part 1 |
| `gen-synth-rgb8-60x40-oxideav-rev-mixed` (.202) | MIXED, RGB with RCT | 10 HT, 38 Part 1 |
| `gen-pydicom-MR_small-oxideav-rev-refine` (.201) | refinement passes, signed 16-bit MR | 16 of 16 with 3 passes |
| `gen-synth-rgb8-60x40-oxideav-rev-refine` (.202) | refinement passes, RGB with RCT | 44 of 48 with 3 passes |

The block counts come from an instrumented decoder. Both references decode the refinement-pass cases to the seed (OpenJPEG for the signed MR; OpenJPH and OpenJPEG for the RGB), so those cases have independent support.

**What the MIXED cases show, and what they don't.** Neither reference decoder reads MIXED: OpenJPEG 2.5 stops with "Unsupported Mixed HT code-block style found", and OpenJPH with "wrong settings in a COD-SPcod parameter". So the oracle is the seed alone (truth = seed, lossless, `families agreeing: []`). The cases check that MIXED streams decode exactly and guard against regressions; they do not show that we read MIXED the way Kakadu writes it.

**Beyond the corpus.** Streams from the same encoder, in all three modes (MIXED, refinement passes, and three quality layers with one HT set each), from five images (12- and 16-bit grey, 8-bit RGB, noise, a flat image): all 15 decode to the samples the encoder started from.

### Robustness

- **Header checks:** the same as JPEG 2000 (shared `prep`, [jpeg2000 STATUS](../jpeg2000/FORMAT.md#robustness)).
- **Fuzzing:** `cargo fuzz` in `codecs/shl-codec-htj2k/fuzz`, with the same target design and seeds as JPEG 2000 ([jpeg2000 Robustness](../jpeg2000/FORMAT.md#robustness)), and overflow checks on.

  | Run | Execs | Crashes | Timeouts | OOMs | Slow inputs |
  |---|---|---|---|---|---|
  | 1 (15 min, 4 workers) | 811,916 | 0 | 0 | 0 | 0 |
  | 2 (15 min, 4 workers) | 230,350 | 0 | 0 | 0 | 0 |
  | 3 (25 min, 4 workers) | 213,103 | 0 | 0 | 0 | **1**: a MIXED tile whose readings all fail took 2 s (13 s with overflow checks); the search is now bounded at 64 attempts |
  | 4 (25 min, 4 workers, final code) | 1,341,758 | 0 | 0 | 0 | 0 |

  The `ht_block` target in `codecs/shl-jpeg2000/fuzz` ran 19.6 M inputs in 10 minutes on 2 workers: no panics.

- **HT block decoder:** `codecs/shl-jpeg2000/tests/ht_golden.rs` ([Decoder](#decoder)), and the `ht_block` fuzz target in `codecs/shl-jpeg2000/fuzz`, which runs the block decoder on arbitrary segments and arguments.
- **Checks:** clean as for JPEG 2000 ([jpeg2000 Robustness](../jpeg2000/FORMAT.md#robustness)).

### Reduced-resolution decode

`decode_frame_scaled` discards the highest resolution levels, as for JPEG 2000, and shares its implementation, checks and results: [jpeg2000 FORMAT.md, Reduced-resolution decode](../jpeg2000/FORMAT.md#reduced-resolution-decode). MIXED frames and frames with several HT sets decode at reduced size too.

### Speed

[PERF.md](PERF.md).

### Known gaps

- **MIXED** code-blocks are covered only by streams from oxideav's encoder, which no reference decoder reads ([cases](#cases-from-the-oxideav-encoder-extragen_oxideavpy)).
- **Several HT sets per code-block** (one per quality layer) are covered only by streams from the same encoder; no reference here reads them either, so they are not corpus cases.
- **Signed lossy cases:** the `openjph` reference cannot check signed cases, so these have a single reference (OpenJPEG).
- **JPEG 2000 gaps:** RGN, tile-level MCT and subsampling ([jpeg2000 Known gaps](../jpeg2000/FORMAT.md#known-gaps)) apply here too.
