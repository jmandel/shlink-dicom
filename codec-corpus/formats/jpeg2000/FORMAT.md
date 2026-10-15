# jpeg2000

**Crate:** `shl-codec-jpeg2000`

**Specifications:** ITU-T T.800 | ISO/IEC 15444-1; ITU-T T.801 | ISO/IEC 15444-2 Annex J (multiple component transformations, for .92 and .93); DICOM PS3.5 8.2.4 and A.4.4 (raw codestream; a JP2 wrapper occasionally appears in the wild)

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.4.90` | 20 |
| `1.2.840.10008.1.2.4.91` | 17 |
| `1.2.840.10008.1.2.4.92` | 4 |
| `1.2.840.10008.1.2.4.93` | 3 |

Sources: generated 18, pydicom 19. Multi-frame cases: 3. Ground truth from seeds: 9.

Expected to be refused (exit 2): `pydicom-JPEG2000-embedded-sequence-delimiter`.

**Disputed** (references disagree on a lossless file; rule on each below): `gen-synth-s12-40x40-openjpeg-rev`, `pydicom-693_J2KR`, `pydicom-J2K_pixelrep_mismatch`.

Weak oracle (fewer than two independent reference families agree): `pydicom-693_J2KR`, `pydicom-GDCMJ2K_TextGBR`, `pydicom-J2K_pixelrep_mismatch`, `pydicom-MR2_J2KR`, `pydicom-MR_small_jp2klossless`, `pydicom-RG1_J2KR`, `pydicom-RG3_J2KR`, `pydicom-US1_J2KR`, `pydicom-emri_small_jpeg_2k_lossless`, `pydicom-examples_jpeg2k`, `pydicom-explicit_VR-UN`.

## Traps

- Signedness: the codestream's SIZ signedness can disagree with DICOM Pixel Representation (`pydicom-J2K_pixelrep_mismatch`). The DICOM attribute governs the output type; rule on what the stored values should be.
- Colour: the RCT (reversible) and ICT (irreversible) multi-component transforms, with photometric YBR_RCT/YBR_ICT; output RGB.
- Tiles, precincts, code-block styles, progression orders (LRCP, RLCP, RPCL, PCRL, CPRL), and multiple quality layers.
- The 9/7 irreversible wavelet in floating point: ±1 against references is expected, and `max_abs` allows it.
- Images smaller than one code-block, odd sizes, and a reduced number of resolution levels.
- 3 DISPUTED cases (`gen-synth-s12-40x40-openjpeg-rev`, `pydicom-693_J2KR`, `pydicom-J2K_pixelrep_mismatch`): rule on each in this file.

## Candidate crates

`hayro-jpeg2000` (pure Rust, memory-safe, widely downloaded through the hayro PDF renderer), `openjp2` (a transpilation of OpenJPEG; check how much `unsafe` it uses), `openjpeg2-pure-rs`, `oxideav-jpeg2000` (also HTJ2K), `j2k` (also HTJ2K). Evaluated in phase 1 by the j2k-survey agent.

## Decision

**Adopt `hayro-jpeg2000` 0.4.x** behind a thin wrapper. This was decided by the phase 1 j2k-survey; the full evidence is in [SURVEY.md](SURVEY.md).

**Evidence:**
- Pure Rust, `#![forbid(unsafe_code)]`, MIT/Apache-2.0, and builds for `wasm32-unknown-unknown`.
- 4 M downloads through the hayro PDF renderer; actively maintained.
- 9.5 k readable lines.
- Corpus: 35/36 with the wrapper steps below. The one miss is two pixels off by 2 on the lossy case `gen-synth-u16-3frame-32x32-openjpeg-cr20`, where every independent decoder disagrees with OpenJPEG; a tolerance change is requested.
- No panics, aborts or hangs in 43 k mutation-fuzz executions.

**Wrapper steps:**
- Strip any JP2 wrapper by taking the `jp2c` payload to the end of the buffer.
- Validate SIZ against Rows, Columns and Samples per Pixel before decoding. Hayro tries to allocate 15 TB on a corrupt SIZ, and aborts.
- Round the f32 samples.
- Subtract 2^(p−1) for SIZ-signed components. Hayro discards the SIZ sign bit.
- Clamp to the SIZ range.

**Rejected:**
- `openjp2`: C allocator calls stop it building for wasm32, and it has 482 `unsafe`.
- `openjpeg2-pure-rs`: 36/36, but an LLM translation of C with 228 `unsafe`. Kept as a differential fuzz oracle.
- `j2k`: a hayro fork with off-by-1 or 2 errors on 16-bit lossless frames.
- `oxideav-jpeg2000`: correct, but 6–15x slower than hayro on Part 1, and it rejects the GDCM file's tile-part count.
- `rust-j2k`: the same GDCM failure, and no JP2.
- Six others: incomplete.

**Disputed cases:** the oracle is right in all three. The `openjpeg-cli` reference reads `opj_decompress` RAWL output without sign extension. The evidence is in [SURVEY.md, Rulings](SURVEY.md#rulings-on-disputed-and-questioned-cases); the format agent copies the rulings into the Rulings section.

**The plan:** see [SURVEY.md, Phase 2 plan](SURVEY.md#phase-2-plan).

**Phase 2 outcome.** Adopted as planned, except that hayro is now vendored: `codecs/shl-codec-jpeg2000/vendor/hayro-jpeg2000` is crates.io 0.4.1 with ten patches. The [vendor README](../../../codecs/shl-codec-jpeg2000/vendor/README.md) is the authoritative list, with each patch's reason and tests. In short:

1. more than 32 quality layers ([33-layer slides](#rarecyte-slides-with-33-quality-layers));
2. no panic in the LRCP iterator when components have different decomposition levels (a fuzz finding);
3. RGN refused as unsupported instead of skipped (skipping it decodes wrong samples);
4. a 1 in a stuffed packet-header bit skipped as OpenJPEG does ([Aperio frame](#aperio-frame-with-a-nonzero-stuffed-bit));
5. HTJ2K block decoding inside hayro, used by `shl-codec-htj2k` ([htj2k FORMAT.md](../htj2k/FORMAT.md));
6. to 9. speed only (`floor`, the horizontal and vertical wavelet passes, the level shift and copies), with outputs byte-identical before and after ([htj2k PERF.md, Phase 2d](../htj2k/PERF.md#phase-2d-ht-decoding-in-hayro));
10. reduced-resolution decoding: an exact `reduce` setting, and three fixes on that path ([Reduced-resolution decode](#reduced-resolution-decode)).

The wrapper (`src/lib.rs`) and the checks and output packing shared with `shl-codec-htj2k` (`src/prep.rs`) do the following:
- strip any JP2 wrapper;
- check the main header against the data set before hayro allocates anything: size, components, one precision of at most Bits Allocated and at most 16, no more than 65,535 tiles, a valid tile grid;
- take 2^(p−1) off signed components, round, and clamp to the SIZ range;
- apply pydicom's sign rule for MONOCHROME images;
- return RGB for colour frames, as set out in [Colour](#colour-of-three-component-frames);
- convert 4:2:2 and 4:2:0 chroma to RGB as OpenJPEG does.

## Rulings

### Cases ruled in the survey (formerly disputed)

The rulings below are copied from [SURVEY.md, Rulings](SURVEY.md#rulings-on-disputed-and-questioned-cases). All three cases had the same cause: the `openjpeg-cli` reference in `scripts/ref_decode.py` read `opj_decompress` RAWL output as `<i2` without sign extension. For a signed component of precision p < 16, `opj_decompress` writes the p-bit two's-complement pattern, so every negative sample came back 2^p too large. The coordinator has since made that reference sign-extend from the SIZ precision, and none of the three is disputed now.

| Case | SIZ | DICOM | Ruling |
|---|---|---|---|
| `gen-synth-s12-40x40-openjpeg-rev` | signed, 12-bit | BS 12, PR 1 | The oracle is correct: the expected output is the seed. |
| `pydicom-693_J2KR` | signed, 14-bit | BS 16, PR 1 | The oracle is correct. Decode as signed 14-bit (−2000…2492), which fits in BS 16 unchanged. SIZ precision below Bits Stored is legal. |
| `pydicom-J2K_pixelrep_mismatch` | **unsigned**, 13-bit | BS 13, **PR 1** | The oracle is correct. Pixel Representation governs. Decode as SIZ says, then take the 13-bit values as stored bits and sign-extend from bit 12. That gives a CT range of −2000…1896. Do not apply a signed DC shift. |

`gen-synth-u16-3frame-32x32-openjpeg-cr20` now allows `max_abs` 2, as the survey asked. Hayro, oxideav and rust-j2k all differ from OpenJPEG by 2 on two pixels of frame 0, and agree with each other within 1.

Both shared-file requests from the survey are applied, and these cases pass.

### Sign handling

CONTRACT ("Sign") requires pydicom's rule, and `prep::pack` implements it. Only for MONOCHROME1/2, and only when the SIZ signedness differs from Pixel Representation, the value is reinterpreted from the codestream precision p:
- unsigned SIZ with PR 1: sign-extend from bit p−1;
- signed SIZ with PR 0: keep the low p bits.

Everything else is written as decoded, and the CLI then masks or sign-extends to Bits Stored. Unit test `pack_sign_rules`.

### Colour of three-component frames

PS3.5 §8.2.4 links the Photometric Interpretation to the codestream's multiple component transformation (MCT):
- with MCT on, it shall be YBR_RCT or YBR_ICT;
- with no MCT, "the components shall correspond to those specified by" the Photometric Interpretation, for example RGB or YBR_FULL.

What `prep::pack` returns:

| Codestream | Data set says | We return | Why |
|---|---|---|---|
| MCT on | anything | RGB (hayro and oxideav undo RCT/ICT) | §8.2.4 |
| no MCT | YBR_ICT or YBR_RCT (`ext-orthanc-jp2k91YBR-ICT`, `ext-issue-cornerstoneWADOImageLoader_367-1_1`) | RGB, samples as decoded | Coordinator ruling. The label is wrong; all three references output the samples unchanged. |
| no MCT | RGB | RGB | §8.2.4 |
| no MCT | YBR_FULL | as declared, so the CLI converts YBR_FULL to RGB as pydicom does | §8.2.4 says these components are YCbCr. This departs from the letter of the coordinator's "no MCT ⇒ RGB" ruling. No corpus case has this combination; the coordinator may override. |
| no MCT, chroma subsampled 2×1 or 2×2 | anything (YBR_FULL_422 in practice) | RGB, converted as OpenJPEG does | See [Subsampled chroma](#subsampled-chroma-leica-aperio-slides-ybr_full_422). |

Unit test `colour_rule`.

### Planar Configuration (`ext-gdcm-HardcopyColor_YBR_RCT_J2K_PC1`)

Coordinator ruling: Planar Configuration does not apply to JPEG 2000. PS3.5 §8.2.4 says its value "is irrelevant since the manner of encoding components is specified in the JPEG 2000 standard, hence it shall be set to 0". The codec always returns interleaved samples, so this file's declared value of 1 is ignored. The case passes.

### Precision above Bits Stored (`ext-gdcm-Osirix10vs8BitsStored`)

The codestream says 10-bit and the data set says Bits Stored 8. Coordinator ruling: for JPEG 2000 and HTJ2K the CLI masks to max(Bits Stored, codestream precision); the foundation agent is implementing this in the CLI. The codec returns the full 10-bit values: our output equals the oracle masked to 8 bits (oracle maximum 644). The case fails only until the CLI change lands.

### Invalid marker mid-codestream (`ext-pylibjpeg-966`)

This is now `expect=decode`, with its oracle from `ext-pylibjpeg-966_fixed`, the same image with the bad marker removed. Hayro skips the marker leniently, and the case passes exactly.

### Subsampled chroma: Leica Aperio slides, YBR_FULL_422

There are 7 cases (`idc-j2k-ybr422-…-leicabiosy-*`), and 23,729 instances in IDC. They are lossy JPEG 2000 from Aperio, converted to DICOM by PixelMed's `TIFFToDicom`:
- three components, with the two chroma components subsampled 2×1 (XRsiz 2, YRsiz 1);
- no MCT;
- Photometric Interpretation YBR_FULL_422.

**What DICOM allows.** PS3.5 §8.2.4 Table 8.2.4-1 lists MONOCHROME1/2, PALETTE COLOR, RGB, YBR_FULL, YBR_RCT and YBR_ICT for JPEG 2000. YBR_FULL_422 is not among them, and the section says nothing about component subsampling. So these files do not conform.

**What we accept.** We decode them anyway, because they are common in the wild. `prepare` accepts subsampled components only in the layouts OpenJPEG converts from sYCC:
- three unsigned components, the first not subsampled;
- the other two both 2×1 or both 2×2;
- no MCT;
- an image offset that is a multiple of the subsampling.

Any other subsampling is `Unsupported` (exit 3).

**How we decode them.** We match what OpenJPEG does. `opj_decompress`, and pylibjpeg-openjpeg as pydicom uses it, treat a three-component codestream with subsampled chroma as sYCC and convert it with `sycc422_to_rgb`/`sycc420_to_rgb`: chroma repeated over 2×1 or 2×2 pixels, then `r = y + (int)(1.402·cr)`, `g = y − (int)(0.344·cb + 0.714·cr)`, `b = y + (int)(1.772·cb)`. The products are computed in double and truncated toward zero, then clamped. `prep::pack` does the same and returns RGB.

**The oracle is wrong for these cases.** pylibjpeg gives the oracle, and its output is OpenJPEG's RGB converted a second time: pydicom sees YBR_FULL_422 and applies its YBR→RGB matrix again.
- Evidence: applying pydicom's `convert_color_space(…, "YBR_FULL", "RGB")` to the `openjpeg-cli` reference reproduces the pylibjpeg output exactly (max |diff| 0 over 3.1 M samples of `-2d25d48c`).
- The double-converted image averages (252, 123, 250), which is magenta. OpenJPEG's output and ours average (232, 229, 231), the near-white background of an H&E slide.
- Against `openjpeg-cli`, our output differs on 0.03–0.05% of samples, by at most 2, in all 7 cases. That spread is the 9/7 float difference between decoders, scaled by the 1.772 chroma factor.

The cases pass today only because `max_abs` is 215–220 (the pylibjpeg vs openjpeg-cli disagreement). **Requested** (shared files): take these cases' oracle from `openjpeg-cli`, or skip pydicom's second conversion when the codestream was sYCC-converted, and set `max_abs` to 2.

### Aperio frame with a nonzero stuffed bit

`idc-j2kr-rct-u8of8-p0-mf-sm-leicabiosy-d680304a`, frame 75 of 110, is a lossless frame on which we were off by up to 89.

- **Cross-check:** OpenJPEG, `openjp2`, `openjpeg2-pure-rs` and rust-j2k decode the frame exactly. hayro (0.4.1 and upstream master) was silently wrong. oxideav and j2k refuse it ("InvalidPacketHeader"; "code-block segment length is truncated").
- **Localising it:** forward RCT + 5/3 DWT of the OpenJPEG output (checked exact against hayro's own coefficients on frame 74) showed hayro's coefficients exact for resolutions 0–3. From resolution 4 on, every code-block was empty. Instrumenting the packet parser showed the cause: a packet header for resolution 3, component 2 has a 1 in the bit stuffed after an 0xFF byte (byte 2089 of the frame).
- **Standard:** T.800 B.10.1 says that bit is 0. OpenJPEG reads only the low 7 bits of the byte after 0xFF, so it ignores the bit.
- **Hayro:** it treated the bit as an error, and in its lenient mode stopped reading the tile's packets without reporting it.
- **Fix:** vendored hayro patch 4 skips the bit. The frame now matches exactly, and the case passes. Regression test `nonzero_stuffed_bit_in_packet_header`.

### RareCyte slides with 33 quality layers

`idc-j2kr-mono2-u16of16-*-rarecyte-*` (four cases) use 33 quality layers, and hayro 0.4.1 capped layers at 32 ("failed to parse COD marker"). The cap has no other basis: layers are counted in a `u8`. Vendored hayro patch 1 raises it to 255, and all four cases now pass exactly. Regression test `thirty_three_quality_layers`. The standard allows up to 65,535 layers; a codestream with more than 255 is refused as invalid.

## JPEG 2000 Part 2 multi-component (.92, .93)

DICOM allows only the Annex J multiple component transformations under these syntaxes (PS3.5 A.4.4). The codestream's Rsiz announces the capability, COD's SGcod is 2 (array-based), and CBD, MCT, MCC and MCO marker segments describe the transformation. Vendored hayro patch 11 implements it ([vendor/README.md](../../../codecs/shl-codec-jpeg2000/vendor/README.md)).

**Decoded:**
- array-based decorrelation and dependency transformations, reversible (integer) and irreversible (f32);
- offset arrays, 16/32-bit integer and 32/64-bit float array elements, MCT and MCC series (Zmct, Zmcc);
- several MCO stages, component collections with permuted input and output lists, null components;
- output components from CBD, with no DC level shift (Annex J);
- reduced-resolution decode: the transformation is applied to the reduced components.

**Refused as unsupported (exit 3):** the wavelet-based transformation (J.3.2; no sample exists), any other Part 2 capability bit in Rsiz, these marker segments in a tile-part header, subsampled components, Part 2 inside a JP2/JPX wrapper. A Part 1 codestream (Rsiz without the capability) that carries these marker segments is refused too.

**Volumes.** PS3.5 A.4.4 lets the frames of a multi-frame image be the components of one codestream, or of one codestream per component collection, each in its own fragments. `decode_frames` decodes such a codestream into its frames, and `codestreams` groups fragments into codestreams. When a .92/.93 file has fewer codestreams than frames, `shl-dicom-decode` decodes it this way, whole; a frame range is cut from the whole volume.

**No reference decoder exists.** OpenJPEG 2.5.4 and Grok refuse a COD with SGcod above 1 ("Invalid multiple component transformation"), including the codestreams OpenJPEG's own encoder writes. That encoder (`opj_set_MCT`) codes wrong components: its custom transform writes integers into the float buffer of the 9/7 path. `opj_compress -m` is not in its option list. Kakadu implements Annex J, but its demo binaries may not be used beyond demonstration, so they are not used here.

**Cases** are made by [`scripts/sources/j2k_part2.py`](../../scripts/sources/j2k_part2.py) from pydicom test images (MIT):
- the forward transformations of Annex J are written there;
- OpenJPEG codes the transformed components as plain signed components (`j2k_part2/opj_mc_enc.c`);
- the script adds the Part 2 marker segments to the main header.

**No independent decoder.** No available decoder reads Part 2 multi-component transforms (OpenJPEG 2.5.4 and Grok refuse them; Kakadu's licence rules it out), so these cases are not independently verified, and each says so in its notes. Ruling (coordinator, 15 Oct): the composite oracle below is accepted, with max_abs 2 on the irreversible decorrelation cases.

The reversible (.92) cases take the seed as ground truth. The reference `j2k-part2` in `ref_decode.py` strips the Part 2 marker segments, decodes the components with OpenJPEG, and applies Annex J in numpy, separately from the Rust code. It reproduces every reversible seed exactly. For the irreversible cases it is the oracle.

| Case | Covers |
|---|---|
| `gen-part2-US1_UNCR-rev-decorrelation` | reversible decorrelation (SERM steps), MCT series, offsets |
| `gen-part2-SC_rgb_16bit-rev-dependency` | reversible dependency, 16-bit RGB, 32-bit and f64 arrays |
| `gen-part2-SC_rgb-two-stages` | two stages, permuted collections, an offset-only collection, MCC series |
| `gen-part2-CT_small-rev-offset` | signed monochrome, offset only |
| `gen-part2-US1_UNCR-irr-decorrelation`, `-cr20` (.93) | irreversible decorrelation (YCbCr), 9/7, all bits and 20:1 |
| `gen-part2-SC_rgb-irr-dependency` (.93) | irreversible dependency, f32 and f64 arrays |

`--volumetric` also makes `gen-part2-emri_small-volume` (10 frames, one codestream) and `gen-part2-emri_small-volume-2-codestreams` (two collections). Both are registered and pass exactly.

**Ruling: max_abs 2 on the irreversible decorrelation cases.** The reference transforms OpenJPEG's components after they are rounded to integers. Rounding each component by up to 0.5, times the 1.402 and 1.772 coefficients of the inverse matrix, moves an output by up to 2. Our decoder transforms the unrounded components. 3.8% (all bits) and 6.4% (20:1) of samples differ, nearly all by 1. The components themselves agree with OpenJPEG within 1.

**Interpretation of the standard.** The text of T.801 (06/2021) has misprints in the reversible equations. The decoder follows the normative inverse equations:
- J-4/J-5: subtract floor(S / t) from the adjusted component, and negate at the last step by the sign of t_N(N−1);
- J-15: add floor(S_i / t_ii);
- J-5: the sum leaves out the adjusted component;
- J-11: default offsets of 0, not 1.

The forward equations the generator uses are their exact inverses, and round-trip tests check both.

## STATUS

Phase 2, 2026-10-14; reduced-resolution decode and this update 2026-10-15.

### check.py

```
cd codecs && CARGO_TARGET_DIR=target/j2k cargo build --release -p shl-dicom-decode
cd ../codec-corpus && uv run python scripts/check.py --name j2k --format jpeg2000 --format htj2k \
  --candidate "../codecs/target/j2k/release/shl-dicom-decode {in} {out}" --quiet
```

**jpeg2000: 177/177 pass** (2026-10-15, with the 9 Part 2 cases; the table below is the October 14 count of 166), and no case is disputed. By source:

| Source | Cases |
|---|---|
| IDC | 82 |
| external (quirk hunter) | 26 |
| generated by `generate.py` | 24 |
| generated by this agent | 15 |
| pydicom | 19 |

**htj2k: 42/42 pass** (see [htj2k STATUS](../htj2k/FORMAT.md#status)).

One pass stands on a wrong oracle. The 7 Leica YBR_FULL_422 cases pass only because pylibjpeg's double colour conversion inflated `max_abs` to 215–220. A fix is requested in [Rulings](#subsampled-chroma-leica-aperio-slides-ybr_full_422); against `openjpeg-cli` our output is within 2.

### New cases: `extra/gen_cases.py`

The 15 cases fill the gaps the survey listed. They are made with `opj_compress` from raw samples of the existing seeds and registered with `generate.register`; the oracle comes from `scripts/oracle.py --format jpeg2000`. Lossless cases take the seed as ground truth.

| Case (`gen-<seed>-…`) | Covers |
|---|---|
| `synth-u16-128x96-opj-rpcl` | RPCL |
| `synth-u16-128x96-opj-pcrl-prec-cb16` | PCRL, explicit precincts, 16×16 code-blocks |
| `synth-rgb8-60x40-opj-cprl-tiles` | CPRL, 6 tiles, RCT |
| `synth-rgb8-60x40-opj-nomct` | RGB without MCT, RLCP |
| `pydicom-CT_small-opj-cbstyle63` | all six code-block style flags, signed 16-bit |
| `synth-s12-40x40-opj-bypass-vcausal-tiles-offset` | BYPASS + VCAUSAL, tiles with image offset (5,3) and tile offset (2,1), NL 2 |
| `synth-s16-64x64-opj-reset-termall-pterm` | RESET + TERMALL + PTERM, 32×8 code-blocks |
| `synth-u16-3frame-32x32-opj-tiles-sop-eph` | SOP/EPH markers, tiles, 3 frames |
| `synth-u12-65x31-opj-tiles-tp-plt` | odd size, tiles, tile-parts per resolution, PLT, RPCL |
| `synth-u8-64x48-opj-n1` | no decomposition (one resolution) |
| `local-mri-slice-opj-n8-cb4x4` | 7 decomposition levels, 4×4 code-blocks |
| `pydicom-MR_small-opj-layers-rlcp` (.91) | 3 quality layers, RLCP |
| `synth-u16-128x96-opj-97-tiles-prec-pcrl` (.91) | 9/7, tiles, precincts, PCRL |
| `synth-rgb8-60x40-opj-97-ict-cprl-cbstyle` (.91) | ICT, CPRL, BYPASS + SEGSYM |
| `synth-s16-64x64-opj-97-layers-tiles` (.91) | 9/7 signed, 2 layers, tiles, tile-parts per layer |

### Robustness

**Header checks.** Before hayro or oxideav sees a frame, `prep::prepare` checks:
- SOC then SIZ;
- the SIZ length;
- a non-empty image area;
- a valid tile grid of at most 65,535 tiles;
- size and component count equal to the data set's;
- one precision, at most Bits Allocated and at most 16;
- subsampling only in the sYCC layouts.

Every truncated prefix of a header is refused. The 15 TB SIZ from `pydicom-JPEG2000-embedded-sequence-delimiter` is refused before any allocation (unit test `huge_siz_is_refused`).

**Fuzzing.** `cargo fuzz` in `codecs/shl-codec-jpeg2000/fuzz`, without a sanitizer. The nightly toolchain here dates from 2023, so the runs use the system 1.99 toolchain with `RUSTC_BOOTSTRAP=1 cargo-fuzz run -O -s none`. The first input byte chooses one of two modes:
- the FrameInfo taken from the mutant's own SIZ, so mutants reach hayro;
- a fixed 64×64 frame, so every SIZ, oversize ones included, meets the header check with a mismatch.

The same byte varies Bits Allocated, Pixel Representation and photometric. Seeds are the corpus frames under 300 KB.

| Run | Execs | Crashes | Timeouts | OOMs |
|---|---|---|---|---|
| 1 (10 min, 4 workers) | 91,915 | **1**: panic in hayro's LRCP iterator (patch 2) | 0 | 0 |
| 2 (10 min, 4 workers, after the patches; new cases and frame 75 added as seeds) | 111,174 | 0 | 0 | 0 |

The crash input is kept as `tests/data/lrcp-coc-fewer-levels.j2c`, regression test `lrcp_with_fewer_levels_in_one_component_does_not_panic`.

The `decode_scaled` target (2026-10-15) drives `decode_frame_scaled` through both the JPEG 2000 and the HT path. Bits 6–7 of the first byte pick 1/2 to 1/16; seeds are the jpeg2000 and htj2k corpus frames under 300 KB.

| Run | Execs | Crashes | Timeouts | OOMs |
|---|---|---|---|---|
| 3 (7 min, 4 workers) | – | **4**, all on hayro's reduced path: an empty tile at the reduced level, a tile-part COD with fewer levels than the reduction, and subsampled components indexed from the full-size tile origin (fixed in patch 10) | 0 | 0 |
| 4 (10 min, 4 workers, after the fixes) | about 446,000 (3,833 edges) | 0 | 0 | 0 |

Part 2 (2026-10-15): bit 6 of the first byte makes the `decode` target call `decode_frames` with one sample per pixel, so a codestream may hold several frames. Seeds added: the Part 2 corpus codestreams and the `tests/data/part2-*` fixtures.

| Run | Execs | Crashes | Timeouts | OOMs |
|---|---|---|---|---|
| 5 (10 min, 4 workers) | 194,246 (3,469 edges) | 0 | 0 | 0 |

A first attempt also stopped on an overflow in the harness itself (SIZ width × height × components in `u64`), fixed with saturating multiplication in both targets. The four inputs are `tests/data/reduced-fuzz-*.bin`, regression test `reduced_decode_fuzz_findings_do_not_panic`.

**Checks.** `cargo test` passes: 14 unit tests, 5 regression tests in `tests/regressions.rs`, 9 Part 2 tests in `tests/part2.rs`, and hayro's own tests (7 of them for patch 11). The two corpus-backed regression tests compare with the oracle and skip if frames are not extracted. Also clean:
- `cargo clippy -p shl-codec-jpeg2000 -p shl-codec-htj2k -p hayro-jpeg2000 --all-targets -D warnings`;
- `cargo build --target wasm32-unknown-unknown` for both crates, with rustup stable 1.97.

### Speed

Current figures are in [htj2k PERF.md, Phase 2d](../htj2k/PERF.md#phase-2d-ht-decoding-in-hayro). That round sped up hayro's wavelet and copy stages (patches 6–9) for JPEG 2000 and HTJ2K alike, and puts JPEG 2000 at about 1.2× OpenJPEG natively. The table this section held before (October 14, before those patches) is superseded. The cost of reduced-resolution decodes is in [htj2k PERF.md, Reduced-resolution decode](../htj2k/PERF.md#reduced-resolution-decode).

### Reduced-resolution decode

`decode_frame_scaled` (CONTRACT.md, "Reduced-resolution decode") discards the s highest resolution levels, as OpenJPEG's `reduce` does. The code-blocks of those levels are not decoded and their wavelet synthesis is skipped (vendored patch 10). The result is ceil(rows / 2^s) × ceil(columns / 2^s). `shl-codec-htj2k` uses the same path through hayro's HT decoder.

**Checked against OpenJPEG** by [`scaled/check_scaled.py`](scaled/check_scaled.py), which runs `opj_decompress -r s` on every jpeg2000 and htj2k frame (the first two of multi-frame cases) at 1/2, 1/4 and 1/8 and compares modulo 2^precision:
- **5/3 reversible:** exact everywhere.
- **9/7:** within the larger of the case's `max_abs` and our full-size difference from OpenJPEG on that frame. That is 1, or 2 on one case, the same as at full size.
- **Totals:** 588 exact and 183 within tolerance; 15 refused, each for a reason below.
- **`ext-pylibjpeg-966`:** OpenJPEG does not decode it at any scale (see [Invalid marker](#invalid-marker-mid-codestream-ext-pylibjpeg-966)).
- **The 7 Leica YBR_FULL_422 slides:** single-tile 4:2:2 at 256², all reduced and compared.

**Unsupported (the CLI then decodes in full and box-downsamples):**
- a component with fewer decomposition levels than s, in the main header or a tile-part (6 of the frame-scale pairs above);
- an image origin other than (0, 0): the CONTRACT size rule differs there, and hayro's reduced placement mixes full-size offsets with reduced coordinates (3);
- subsampled components, unless the frame is one tile whose size is a multiple of the subsampling × 2^s;
- HTJ2K frames that only oxideav decodes (MIXED code-blocks, several HT sets) (6).

**Values** are OpenJPEG's reduced reconstruction, the wavelet LL band, not a box average of the full decode. The 5/3 LL is (−1, 2, 6, 2, −1)/8 per level, so on sharp or noisy content the difference from a box average can be large. pydicom's MONOCHROME sign rule is applied after the reduction, as for a full decode.

### Known gaps

- **POC** (progression order change) is refused as unsupported (exit 3) by hayro 0.4.1, and so is **RGN** after patch 3. Upstream master supports both; neither appears in the corpus.
- **Tile-level MCT:** colour is decided from the main-header COD. Hayro also applies the first tile's MCT flag to every tile. A codestream whose tiles differ in MCT would be wrong. This is legal, but none is known.
- **Subsampling** other than 4:2:2 and 4:2:0 chroma, or with an odd image offset: exit 3.
- **Part 2:** see [its section](#jpeg-2000-part-2-multi-component-92-93) for what is refused.
- **Precision above 16 bits** is refused: exit 3 with Bits Allocated 32, exit 2 when it exceeds Bits Allocated.
- **Silent truncation:** in lenient mode, hayro stops reading a tile's packets at the first malformed packet header and returns what it has, without an error, as OpenJPEG does with truncated codestreams. That is why the stuffed-bit bug was silent. A strict-mode decode would report such errors, but would also refuse files the references read.
- **Reduced resolution:** see the Unsupported list in [Reduced-resolution decode](#reduced-resolution-decode).
- **No differential fuzzing:** the survey suggested `openjpeg2-pure-rs` as a differential oracle in the fuzz target; it was not done. The fuzz target checks only the absence of panics and the output size.
