# jpeg-dct

**Crate:** `shl-codec-jpeg (shared with jpeg-lossless; one owner)`

**Specifications:** ITU-T T.81 | ISO/IEC 10918-1 (processes 1, 2, 4: baseline 8-bit, extended 12-bit, Huffman); DICOM PS3.5 A.4.1, §8.2.1

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.4.50` | 18 |
| `1.2.840.10008.1.2.4.51` | 8 |

Sources: generated 7, local 2, pydicom 17. Multi-frame cases: 2. Ground truth from seeds: 0.

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

## STATUS

**check.py:** jpeg-dct pass=139/139 (corpus of October 2026).

**Exactness:** bit-identical to dcmtk (IJG 6b) on all 25 decodable cases, and to gdcm on the 19 it can decode.

**Tests:**
- `cargo test -p shl-codec-jpeg` covers unit tests (bit reader, Huffman, IDCT, range limit, upsampling, colour) and `tests/corpus.rs`. The corpus test needs `extract_frames.py` output first.
- `cargo clippy --all-targets -D warnings` is clean.
- The `wasm32-unknown-unknown` release build succeeds. Build it with the rustup stable toolchain, because the system Rust has no wasm32 std.

**Speed** (release build, one core, codec only, Ryzen 5 3600):
- 640×480 4:2:2 colour (`color3d_jpeg_baseline`): 0.88 ms per frame natively and 1.56 ms in wasm with simd128, against 0.82 ms for libjpeg-turbo.
- 2320×2920 12-bit mono (`local-wrist-lateral`): 18.3 ms natively, against 31.8 ms for libjpeg-turbo.

The IDCT, upsampling and colour conversion use AVX2 (chosen at run time) or wasm simd128, bit-identical to the scalar code. See [PERF.md](PERF.md) for each step, reference decoders and wasm.

**Reduced-resolution decode** (`decode_frame_scaled`, CONTRACT.md "Reduced-resolution decode"): 1/2, 1/4 and 1/8 for baseline and extended DCT, 8 and 12-bit, through the `jidctred.c` reduced IDCTs. Lossless JPEG returns Unsupported.
- **Checked against libjpeg-turbo 3.2.0's own scaled decode** with [`scaled/check_scaled.py`](scaled/check_scaled.py), which builds the small oracle [`scaled/turbo_scaled.c`](scaled/turbo_scaled.c) against the system library. 402 of 405 case-scale pairs are byte-identical, 8-bit and 12-bit alike. The other 3 are `ext-gdcm-PHILIPS_Gyroscan-12-Jpeg_Extended_Process_2_4`, which libjpeg-turbo refuses ("Bogus Huffman table definition"); this decoder accepts it at full size under an existing ruling.
- **12-bit against a block average of the full decode:** within 1.0 on every complete block with no sample clamped to 0 or 4095. The reduced IDCTs are the exact block average of the 8×8 transform before rounding (unit test `reduced_idct_is_block_average`). Blocks with clamped samples differ by up to about 40 (`local-wrist-*` at 1/2), because the full decode clips ringing before the average and the reduced decode does not. Partial edge blocks average the encoder's padding.
- **Full-size output** is unchanged: the same bytes on every corpus frame before and after, and check.py stays at 100%.
- **Fuzzing:** a `decode_scaled` target in `shl-codec-jpeg/fuzz`; results below.

**Not supported:** these return `Unsupported` (exit 3):
- progressive (SOF2; `.55` is retired);
- arithmetic coding;
- hierarchical processes;
- a height given by DNL;
- fractional sampling ratios.

**Fuzzing:** no panics, hangs or OOMs in about 1.7 million libFuzzer executions over 15 minutes. Details are in the [jpeg-lossless STATUS](../jpeg-lossless/FORMAT.md#status), which covers the shared crate.
