# JPEG XL

Transfer syntaxes:

| UID | Name | Lossy |
|---|---|---|
| 1.2.840.10008.1.2.4.110 | JPEG XL Lossless | no |
| 1.2.840.10008.1.2.4.111 | JPEG XL JPEG Recompression | yes (the JPEG it carries is lossy) |
| 1.2.840.10008.1.2.4.112 | JPEG XL | yes |

Crates: `codecs/shl-jpegxl` (the decoder) and `codecs/shl-codec-jpegxl` (the DICOM wrapper). Cases: `scripts/sources/jpegxl.py`.

## Spec

- ISO/IEC 18181-1 (codestream), 18181-2 (container).
- DICOM PS3.5 [8.2.15](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.15.html) and [A.4.12](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.12.html) (Sup 232):
  - one fragment per frame;
  - Table 8.2.15-1: MONOCHROME1/MONOCHROME2 with 1 sample, Pixel Representation 0 or 1, Bits Allocated 1, 8, 16 or 24 and Bits Stored 1–24 (.110, .112); MONOCHROME2 8-bit unsigned only for .111;
  - colour: RGB, YBR_RCT or XYB, 3 samples, unsigned, Bits Allocated 8, 16 or 24 (.110, .112); RGB, YBR_FULL_422 or XYB, 8-bit, for .111;
  - Planar Configuration 0; the codestream's own characteristics control decoding when they disagree with the data set.

## Decoder

`shl-codec-jpegxl` is a thin wrapper around `shl-jpegxl` (`codecs/shl-jpegxl`), a JPEG XL decoder written for this project: pure Rust, `#![forbid(unsafe_code)]`, no dependencies, and it builds for `wasm32-unknown-unknown`. It includes its own Brotli decoder for the `jbrd`, `brob` and compressed metadata boxes.

**What it decodes:**
- the bare codestream and the ISO BMFF container (`jxlc`, `jxlp`, `jbrd`, `Exif`, `xml `, `brob`);
- Modular frames: every predictor including the weighted predictor, MA trees, the RCT, palette and squeeze transforms, integer and floating-point samples, extra channels;
- VarDCT frames: every transform type (DCT sizes from 2×2 to 256×256, IDENTITY, AFV), custom quantisation tables, adaptive quantisation, chroma-from-luma, progressive passes, LF frames;
- Gaborish, the edge-preserving filter, patches, splines, noise, upsampling, chroma subsampling, blending, reference frames and animation (the first displayed frame is returned);
- colour: XYB to the image's own colour space, as libjxl does it: any primaries and white point (sRGB, Display P3, BT.2100, custom; D65, DCI, E, custom), through the primaries matrix with Bradford adaptation, and the sRGB, linear, gamma, DCI, BT.709, PQ and HLG transfer functions (HLG with libjxl's inverse OOTF), with the transfer curves ported from libjxl; YCbCr; orientation;
- JPEG reconstruction from the `jbrd` box (`reconstruct_jpeg`), byte-identical to the JPEG that was recompressed.

**Refused as unsupported (exit 3):** a frame saved for reference after the colour transform but not displayed. XYB images that carry an ICC profile come back as linear sRGB, as libjxl gives them without a colour management system. In the wrapper: CMYK (a black extra channel), floating-point samples, more bits than Bits Allocated, and Bits Allocated 24 (the canonical form has no 24-bit sample type).

**Output.** Lossless (modular, non-XYB) images come back as their exact integers. Everything else comes back as f32 in the image's colour space, nominal range 0.0–1.0.

**The wrapper** (`src/lib.rs`):
- reads the image header first: the image must match Rows × Columns, its colour channel count (grey or RGB; alpha is dropped) must match Samples per Pixel, and its bit depth must fit Bits Allocated. Nothing is decoded before these checks pass;
- caps the decode at Rows × Columns pixels;
- turns each float sample `v` into `v × (2^bits − 1)`, rounded to nearest with ties to even and clamped, where `bits` is the codestream's bit depth. This is libjxl's float-to-integer conversion, except that for 8-bit output libjxl also adds an ordered dither, which the wrapper does not (see [Rulings](#rulings));
- returns colour as RGB (`ColorOut::Rgb`), whatever the declared photometric (RGB, YBR_RCT, XYB, YBR_FULL_422).

There is no reduced-resolution decode: the CLI decodes in full and box-downsamples.

**Signed data.** JPEG XL samples are unsigned. Writers store a signed frame as its two's-complement bit pattern at the codestream's bit depth (cornerstone's `CTImage` .110 file: Pixel Representation 1, 16-bit codestream). The codec returns the pattern; the CLI sign-extends from Bits Stored.

**How it is checked**, besides the corpus ([STATUS](#status)):
- the [libjxl conformance suite](https://github.com/libjxl/conformance): all 40 test cases within their tolerances (for example `bike`, with splines, noise and patches: peak error 2.5e-4 against a limit of 7e-3);
- byte-identical output to `djxl` (libjxl 0.12.0) for 52 lossless files: the corpus's lossless frames and lossless encodes, at effort 1, 3 and 7, of CT, MR, digital X-ray and photographic test images;
- JPEG reconstruction byte-identical to `djxl` and to the original JPEG for 44 files: the corpus's .111 frames, three conformance cases, and `cjpeg` baseline, progressive, restart-interval, optimised, greyscale, 4:2:2, 4:2:0 and RGB JPEGs, with ICC, COM, Exif and XMP, compressed and not;
- `tests/decode.rs` decodes small `cjxl` files (lossless 16-bit, lossy RGB, JPEG recompression) and checks that every truncated prefix is refused. It also decodes lossy files made with libjxl's encoder API in nine colour encodings (Display P3 with sRGB and DCI curves, BT.2100 with PQ and HLG, Adobe RGB, ProPhoto with a D50 white, sRGB primaries with D50 and E whites, sRGB with HLG) and compares them with `djxl`'s float output: within 1e-4 peak (1e-3 for PQ, which is steep near black); `tests/regressions.rs` holds fuzz findings;
- fuzzing ([STATUS](#status)).

## References (oracle)

`imagecodecs.jpegxl_decode` and the `djxl` tool, one frame at a time (`ref_decode.py`: `imagecodecs-jxl`, `djxl`). Both are libjxl 0.12.0, so they are one family; for lossless cases from seeds the seed is the oracle and libjxl must reproduce it. libjxl returns unsigned samples at the codestream's bit depth (checked on the 12-bit seeds), so the reference masks to Bits Stored and sign-extends signed data.

## Cases

| Kind | Cases | Source, licence |
|---|---|---|
| Real .110 | `ext-cs3d-CTImage…4.110` (16-bit signed CT), `ext-cs3d-ColorImage…4.110` (RGB 8-bit) | cornerstone3D dicomImageLoader testImages, MIT |
| Real .111 | `ext-dcm4che-will-jxl` (27 frames, YBR_FULL_422) | dcm4che-test-data, MPL-1.1/GPL-2.0/LGPL-2.1 |
| Generated .110 | `gen-<seed>-cjxl-lossless-e1`, `-e7`: 8, 12 and 16-bit, signed 12 and 16-bit, RGB, 3 frames, 1×1, pydicom CT_small and MR_small | corpus seeds; cjxl 0.12.0 |
| Generated .112 | `gen-<seed>-cjxl-d1`, `-d3`, `-d1-modular` on the unsigned seeds (colour declared XYB) | corpus seeds; cjxl 0.12.0 |
| Generated .111 | `gen-synth-*-ijg-baseline-cjxl-jpeg`: `cjxl --lossless_jpeg=1` of the corpus's JPEG Baseline cases | corpus jpeg-dct cases; cjxl 0.12.0 |

## Rulings

None needed. Lossy frames (.112, and .111 decoded to pixels) are within 1 of libjxl. For 8-bit output libjxl adds an ordered dither before rounding; this decoder rounds plainly. Compared with `djxl` on 28 lossy files (the corpus's 21 and 7 lossy encodes of the CT, MR, X-ray, slide and photographic test images), 33,153,349 of 39,727,425 samples are identical and the rest differ by 1. With the dither emulated, 39,722,410 are identical.

## STATUS

2026-10-16, with `shl-jpegxl`.

- **Corpus:** 40/40 pass: 21 lossless (.110; 19 from seeds, 2 real) exact, 15 .112 and 4 .111 within 1 of libjxl.
- **Fuzz:** `cargo-fuzz`, no sanitizer, overflow checks on (`RUSTC_BOOTSTRAP=1 cargo-fuzz run -O -a -s none`), on the final code. No crashes, timeouts or out-of-memory in any run.
  - `codecs/shl-jpegxl/fuzz`, target `decode` (images capped at 2^20 pixels), seeded with the corpus frames, the conformance files and earlier fuzz corpora: 30 minutes, 4 processes, 2,425,609 inputs.
  - same crate, target `reconstruct` (JPEG reconstruction), seeded with the 44 recompressed JPEGs above: 30 minutes, 2 processes, 2,801,726 inputs.
  - `codecs/shl-codec-jpegxl/fuzz`, target `decode` (FrameInfo from the input's own header; the first byte picks Bits Allocated and Pixel Representation): 15 minutes, 4 processes, 9,010,834 inputs.
  - Earlier runs found a frame-size overflow and ICC profiles that took seconds to expand; both are fixed and in `tests/regressions.rs`.
- **Speed:** see [PERF.md](PERF.md). Single-threaded, against libjxl 0.12.0 measured the same way: in wasm (Chromium, simd128, libjxl built with emscripten) 1.12–1.31× libjxl's time on lossy files at distance 1 and level with it on lossless files at effort 7; natively 1.8–2.2× libjxl's time on lossy files and 0.8× at effort 7.
- **Memory:** peak resident memory of a native decode is at or below jxl-oxide's on all 34 images. jxl-oxide uses up to 1.55× as much on the lossless files and 1.1–2.8× as much on the lossy ones.
- **Size:** `shl_dicom_decode_jxl.wasm` is 1427 KiB, 442 KiB gzip; JPEG XL adds 543 KiB (168 KiB gzip) to the decoder.
- **Tests:** `cargo test`, `cargo clippy --all-targets -D warnings`, and a `wasm32-unknown-unknown` build succeed. `viewer-kit/test/verify-oracle.ts` and `scaled.ts` pass on the JPEG XL cases with the wasm module, `viewer-kit/test/pool.mjs` decodes JPEG XL through the lazily loaded module, and the whole-slide JPEG XL checks in `web/checks/wsi-checks.mjs` (lossless, lossy and recompressed slides) match libjxl.
