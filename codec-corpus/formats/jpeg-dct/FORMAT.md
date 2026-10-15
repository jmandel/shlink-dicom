# jpeg-dct

**Crate:** `shl-codec-jpeg (shared with jpeg-lossless; one owner)`

**Specifications:** ITU-T T.81 | ISO/IEC 10918-1, every DCT process: baseline and extended (1–5), spectral selection and full progression (6–13), Huffman or arithmetic coding, and hierarchical (16–27, Annex J); DICOM PS3.5 A.4.1, §8.2.1

## Corpus

| Transfer syntax | Cases |
|---|---|
| `.50` baseline | 109 |
| `.51` extended | 31 |
| `.52` extended, arithmetic | 14 |
| `.53` spectral selection | 11 |
| `.54` spectral selection, arithmetic | 6 |
| `.55` full progression | 11 |
| `.56` full progression, arithmetic | 7 |
| `.59`–`.64` hierarchical (sequential, spectral selection, progressive; Huffman and arithmetic) | 23 |

Sources: generated 80, IDC 73, external 39, pydicom 17, local 2, repair 1.

The only real files in the retired syntaxes are two cornerstone3D test images (`ext-cs3d-CTImage.dcm_JPEGProcess6_8…53`, `…10_12…55`; MIT): 12-bit CT, SOF2 with 3 and 6 scans. The rest are encoded by [`scripts/sources/jpeg_retired.py`](../../scripts/sources/jpeg_retired.py) from the corpus seeds, with three encoders: Thomas Richter's libjpeg (`jpeg`, every process), libjpeg-turbo's `cjpeg` (`-arithmetic`, `-progressive`, `-scans` for spectral selection without successive approximation) and dcmtk's `dcmcjpeg +es/+ep`. They cover 8 and 12-bit grey, 4:2:0 and 4:4:4 colour, restart intervals, and two- and three-level hierarchies. No file was found in gdcmData, pylibjpeg-data, the pydicom test data or dcm4che's test data; the NEMA WG4 server returns 404, and DCMTK ships no test images.

Expected to be refused (exit 2): `pydicom-SC_rgb_jpeg`.

## Traps

- 12-bit extended sequential (`.51`): 16-bit quantisation tables, and samples range 0–4095.
- Colour: YCbCr→RGB by default. Honour an Adobe APP14 transform flag of 0 (`pydicom-SC_jpeg_no_color_transform`), and treat the DICOM photometric `RGB` with JFIF absent carefully. The reference decoders differ, so check the tolerance and rulings.
- Chroma subsampling 4:2:2 and 4:2:0, and the upsampling method: libjpeg's 'fancy' upsampling versus simple replication causes ±1–2 differences. `max_abs` comes from reference disagreement, so match libjpeg if you want exact results.
- Restart markers (DRI/RSTn); multiple scans (not progressive in DICOM, but handle them).
- Match libjpeg's integer IDCT (jidctint 'islow') to get bit-identical results; others give ±1.
- Fragments: one frame may span several fragments (join them), and a multi-frame file has one or more fragments per frame (the CLI splits them; you receive one codestream).

## Candidate crates

`jpeg-decoder` (8-bit; 12-bit no), `zune-jpeg` (8-bit, fast), `oxiarc-jpeg` (claims extended and lossless; small user base), and the in-repo `crates/shl-dicom-core/src/jpeg12.rs` (hand-written 12-bit; reuse or replace).

## References for the retired processes

pydicom refuses these syntaxes, so `ref_decode.py` gives the codestreams to the libraries directly (`applicable()` lists `libjpeg-turbo`, `libjpeg-richter`, `dcmtk` for them):

| Process | libjpeg-turbo 3.2 (imagecodecs) | Richter libjpeg (pylibjpeg-libjpeg 2.4) | dcmtk 3.6 `dcmdjpeg` |
|---|---|---|---|
| progressive and spectral selection, Huffman | yes | yes | yes |
| arithmetic, sequential and progressive | yes | yes | no |
| arithmetic lossless | no ("omitted at compile time") | yes | no |
| hierarchical (any) | no (marker DHP unsupported) | yes, with a non-standard upsampler (below); refuses 16-bit | no |

Each was checked by decoding streams of every process. libjpeg-turbo and dcmtk are the IJG family this decoder reproduces; Richter's IDCT and colour conversion differ by 1–3.

## Decision

**Build.** `shl-codec-jpeg` is an in-house decoder shared by jpeg-dct and jpeg-lossless: one marker parser, Huffman table builder and bit reader, with a DCT path and a lossless path. It has no dependencies beyond `shl-codec-common`. The crate is `#![deny(unsafe_code)]`; the only exception is `simd.rs`, whose AVX2 dispatch call and vector loads and stores are documented there (see [PERF.md](PERF.md)).

Evidence, from running the candidate crates on every extracted corpus frame:

- `jpeg-decoder` 0.3 fails all 6 12-bit `.51` frames (`unsupported JPEG feature: SamplePrecision(12)`), so it cannot cover this format alone.
- `zune-jpeg` 0.4 fails the 12-bit frames ("can only parse 8-bit images"), all 92 lossless frames, and one Adobe-marker frame.
- `oxiarc-jpeg` was not tried. Once marker, Huffman and bit-reader code had to exist for 12-bit anyway, the lossless path was about 160 more lines.
- The hand-written `crates/shl-dicom-core/src/jpeg12.rs` is monochrome-only with a float IDCT, so it can't be bit-exact with any reference. It is replaced, not reused.

The DCT path reproduces IJG libjpeg 6b's default decoder rather than approximating it:

- `jidctint` integer IDCT, with `PASS1_BITS` 2 for 8-bit and 1 for 12-bit;
- libjpeg's post-IDCT range-limit table, including its wraparound;
- `jdsample` fancy upsampling for h2v1 and h2v2 when the downsampled width is more than 2, and box replication otherwise;
- `jdcolor` 16-bit fixed-point YCbCr→RGB tables.

Our output is bit-identical to dcmtk (IJG) on all 25 decodable cases, and to gdcm on the 19 it decodes (gdcm refuses 12-bit `.51`).

## Rulings

**Colour transform.** Three-component DCT frames are always returned as RGB (`ColorOut::Rgb`). Whether YCbCr→RGB is applied is decided in this order:

1. JFIF APP0 present: YCbCr.
2. Adobe APP14 present (with at least 12 bytes of data, as libjpeg requires): transform 0 means RGB, any other value YCbCr.
3. Neither marker: the DICOM photometric decides. `YBR_*` means YCbCr, anything else means no transform.

libjpeg itself guesses from component identifiers in step 3: 1,2,3 means YCbCr, 'R','G','B' means RGB, anything else YCbCr. That guess fails `pydicom-SC_jpeg_no_color_transform` (identifiers 0,1,2, no markers, photometric RGB). All three references leave that file untransformed.

To see what the references do when the label and the codestream disagree, I relabelled the photometric of four corpus files and decoded them with each reference:

| File, relabelled to | pylibjpeg | gdcm | dcmtk |
|---|---|---|---|
| `SC_rgb_jpeg_dcmtk` (JFIF), RGB | converts (follows JFIF) | converts | no conversion (follows label) |
| `SC_rgb_dcmtk_+eb+cr` (Adobe transform 0), YBR_FULL | no conversion (follows APP14) | no conversion | converts |
| `SC_jpeg_no_color_transform` (no markers, ids 0,1,2), YBR_FULL | converts | converts | converts |
| `SC_rgb_jpeg_lossy_gdcm` (no markers, ids 1,2,3), RGB | no conversion | no conversion | no conversion |

Markers win when present, as in pylibjpeg and gdcm. dcmtk's default (`+cp`) follows the label instead. With no markers, all three follow the photometric. The rule above matches the majority in every row. Because Adobe transform 0 overrides a YBR label, the codec reports `Rgb` even when it does not convert, so the CLI does not convert a second time.

**`pydicom-JPEG-lossy`** (`.51`, SOS has Se = 0 in a sequential scan): T.81 requires Ss=0, Se=63 for sequential DCT. libjpeg only warns about this and decodes all 64 coefficients. pylibjpeg refuses the file, gdcm has no 12-bit support, and the oracle comes from dcmtk. We follow libjpeg and ignore Ss/Se/Ah/Al in sequential scans. The output is bit-identical to the oracle (max diff 0).

**`pydicom-SC_rgb_jpeg`** (expect=error): the fault is in the DICOM encapsulation: the Basic Offset Table item tag reads (0000,0000), and dcmtk reports a parse error before reaching pixel data. The CLI refuses it with exit 2. Its codestream on its own decodes. Its APP14 segment carries only 10 bytes, so it is ignored as libjpeg does, and the photometric (RGB) means no transform. The oracle's expectation is correct.

**Lossy tolerances.** No oracle looks wrong. The oracle comes from Richter's libjpeg (pylibjpeg). Our maximum difference from it equals the case's `max_abs` exactly in every case where they differ: 1 for 12-bit, up to 5 for 4:2:2 colour upsampling. That is because `max_abs` is the IJG-vs-Richter disagreement and we reproduce IJG exactly. The check therefore passes with no slack. If an IJG-family reference were the primary oracle, these cases would compare at max diff 0.

**Truncated or damaged entropy data** is handled the way libjpeg handles it. Past the end of data, or past an unexpected marker, the reader supplies zero bits. At a restart point it resynchronises to the next RSTn marker. Only a corrupt Huffman code is `Invalid`. To stop a short stream from forcing a huge allocation, a frame is refused as `Invalid` when the codestream is shorter than the minimum the frame needs (2 bits per DCT block). Frames with no DHT segment (Motion-JPEG style) use the T.81 K.3 tables, as libjpeg-turbo does.

**Hierarchical upsampling (T.81 J.1.1.2).** The standard expands a reference by inserting the truncated mean of the two neighbours, horizontally first and then vertically between the expanded rows, repeating the last column and row. This decoder does exactly that. Richter's libjpeg keeps the half from the horizontal step and truncates once, so where both directions are interpolated it gives floor((a+b+c+d)/4) instead of floor((floor((a+b)/2) + floor((c+d)/2))/2), 1 higher in about a quarter of those samples. Evidence: on lossless hierarchical streams from the T.81 encoder in `jpeg_retired/hier_lossless.py`, this decoder returns the seed exactly, and Richter differs by 1 only at samples interpolated both ways, matching the floor-of-four-mean model sample for sample. Richter's encoder also produces lossless hierarchical streams its own decoder does not invert, so it is not used for `.65`/`.66`. Ruling (coordinator, 15 Oct): T.81 is followed; the 12 lossless hierarchical cases Richter decodes stay marked disputed, with the reason in their notes.

**Lossy hierarchical tolerance.** Richter is the only reference for `.59`–`.64`. Each case's `max_abs_override` is set by `jpeg_retired.py --tolerances`, before and independently of this decoder: (how far Richter's output moves when only its upsampler is made T.81's, `jpeg_retired/richter-spec-upsampling.patch`, on that file) + (Richter against IJG on the non-hierarchical `richter-arith` twin of the same seed and sampling). That gives 3 for grey (2 + 1) and 6 for 4:2:0 colour (3 + 3). Measured: 0 to 2 for grey and 5 for colour. Accepted by the coordinator (15 Oct).

**Progressive block smoothing.** libjpeg smooths blocks whose low-frequency coefficients are not fully refined. With a complete scan script (every corpus file) nothing is unrefined at the end and libjpeg does not smooth; this decoder never smooths, so an incomplete progressive file would differ from libjpeg in its unrefined blocks.

## STATUS

**check.py:** jpeg-dct pass=212/212. Every non-hierarchical case is bit-identical to libjpeg-turbo or dcmtk (its oracle; Richter differs by 1–3). Hierarchical cases are within the tolerance above.

**Coding processes:** sequential Huffman decodes each block straight to samples. Progressive (Huffman, as libjpeg-turbo's `jdphuff.c`: DC first and refinement, AC first with end-of-band runs, AC refinement), arithmetic (T.81 Annex D and F.2.4, as `jdarith.c`, including DAC conditioning and restart handling) and hierarchical frames go through a buffer of quantised coefficients, which the same IDCT, upsampling and colour code turns into samples. Hierarchical images (DHP, EXP, differential DCT frames with unpredicted DC and no level shift, Annex J) are reconstructed in integers without clamping until the final image.

**Exactness:** bit-identical to dcmtk (IJG 6b) on the baseline and extended cases, and to gdcm on the 19 it can decode.

**Tests:**
- `cargo test -p shl-codec-jpeg` covers unit tests (bit reader, Huffman, IDCT, range limit, upsampling, colour, QM table) and `tests/corpus.rs`. The corpus test needs `extract_frames.py` output first. It fails today only on `ext-gdcm-DCMTK_JPEGExt_12Bits` (Bits Allocated 12, which the CLI infers as 16 before calling the codec; the codec-level test passes the raw 12).
- `cargo clippy --all-targets -D warnings` is clean.
- The `wasm32-unknown-unknown` release build succeeds. Build it with the rustup stable toolchain, because the system Rust has no wasm32 std.

**Speed** (release build, one core, codec only, Ryzen 5 3600):
- 640×480 4:2:2 colour (`color3d_jpeg_baseline`): 0.88 ms per frame natively and 1.56 ms in wasm with simd128, against 0.82 ms for libjpeg-turbo.
- 2320×2920 12-bit mono (`local-wrist-lateral`): 18.3 ms natively, against 31.8 ms for libjpeg-turbo.

The IDCT, upsampling and colour conversion use AVX2 (chosen at run time) or wasm simd128, bit-identical to the scalar code. See [PERF.md](PERF.md) for each step, reference decoders and wasm. The coefficient-buffered processes did not change baseline speed (minimum of 15 runs, alternated with the previous build, within the machine's noise).

**Reduced-resolution decode** (`decode_frame_scaled`, CONTRACT.md "Reduced-resolution decode"): 1/2, 1/4 and 1/8 for baseline, extended, progressive and arithmetic DCT, 8 and 12-bit, through the `jidctred.c` reduced IDCTs. Lossless and hierarchical JPEG return Unsupported.
- **Checked against libjpeg-turbo 3.2.0's own scaled decode** with [`scaled/check_scaled.py`](scaled/check_scaled.py), which builds the small oracle [`scaled/turbo_scaled.c`](scaled/turbo_scaled.c) against the system library. Every case-scale pair libjpeg-turbo decodes is byte-identical, 8-bit and 12-bit, progressive and arithmetic included. `ext-gdcm-PHILIPS_Gyroscan-12-Jpeg_Extended_Process_2_4` is refused by libjpeg-turbo ("Bogus Huffman table definition"); this decoder accepts it at full size under an existing ruling.
- **12-bit against a block average of the full decode:** within 1.0 on every complete block with no sample clamped to 0 or 4095. The reduced IDCTs are the exact block average of the 8×8 transform before rounding (unit test `reduced_idct_is_block_average`). Blocks with clamped samples differ by up to about 40 (`local-wrist-*` at 1/2), because the full decode clips ringing before the average and the reduced decode does not. Partial edge blocks average the encoder's padding (Richter's encoder pads far from edge replication: up to 1357 on the 65×31 12-bit seed).
- **Speed:** see [PERF.md](PERF.md#reduced-resolution-decode).

**Not supported:** these return `Unsupported` (exit 3):
- a height given by DNL;
- fractional sampling ratios.

**Fuzzing:** see the [jpeg-lossless STATUS](../jpeg-lossless/FORMAT.md#status), which covers the shared crate.
