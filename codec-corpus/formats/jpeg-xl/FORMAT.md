# JPEG XL

Transfer syntaxes:

| UID | Name | Lossy |
|---|---|---|
| 1.2.840.10008.1.2.4.110 | JPEG XL Lossless | no |
| 1.2.840.10008.1.2.4.111 | JPEG XL JPEG Recompression | yes (the JPEG it carries is lossy) |
| 1.2.840.10008.1.2.4.112 | JPEG XL | yes |

Crate: `codecs/shl-codec-jpegxl`. Cases: `scripts/sources/jpegxl.py`.

## Spec

- ISO/IEC 18181-1 (codestream), 18181-2 (container).
- DICOM PS3.5 [8.2.15](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.15.html) and [A.4.12](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.12.html) (Sup 232):
  - one fragment per frame;
  - Table 8.2.15-1: MONOCHROME1/MONOCHROME2 with 1 sample, Pixel Representation 0 or 1, Bits Allocated 1, 8, 16 or 24 and Bits Stored 1–24 (.110, .112); MONOCHROME2 8-bit unsigned only for .111;
  - colour: RGB, YBR_RCT or XYB, 3 samples, unsigned, Bits Allocated 8, 16 or 24 (.110, .112); RGB, YBR_FULL_422 or XYB, 8-bit, for .111;
  - Planar Configuration 0; the codestream's own characteristics control decoding when they disagree with the data set.

## Decoder

`decode_frame` wraps [jxl-oxide](https://github.com/tirr-c/jxl-oxide) 0.12.6 with default features off (no rayon, no lcms2), single-threaded (`JxlThreadPool::none`):

1. The codestream (bare or in the ISO BMFF container) is read; the image must match Rows × Columns, and its colour channel count (grey or RGB; alpha is dropped) must match Samples per Pixel. CMYK and floating-point samples are Unsupported.
2. The first keyframe is rendered and each sample `v` (nominal 0.0–1.0) becomes `round(v × (2^bits − 1))`, clamped, where `bits` is the codestream's bit depth. This is libjxl's float-to-integer output. Lossless (modular) data comes back exactly.
3. **XYB images with an sRGB transfer curve** are rendered as linear light and the exact sRGB curve is applied in f64. jxl-oxide's own sRGB step is a fast approximation (relative error about 1e-4) that left 16-bit lossy frames up to 8 away from libjxl; with the exact curve they are within 1.
4. Colour comes back as RGB (`ColorOut::Rgb`), whatever the declared photometric (RGB, YBR_RCT, XYB, YBR_FULL_422).
5. Memory: jxl-oxide's allocation tracker caps image buffers at 48 bytes per output sample plus 64 MiB.

Bits Allocated 24, allowed by Table 8.2.15-1, is Unsupported: the canonical form has no 24-bit sample type. There is no reduced-resolution decode: jxl-oxide has no downsampled render, so the CLI decodes in full and box-downsamples.

**Signed data.** JPEG XL samples are unsigned. Writers store a signed frame as its two's-complement bit pattern at the codestream's bit depth (cornerstone's `CTImage` .110 file: Pixel Representation 1, 16-bit codestream). The codec returns the pattern; the CLI sign-extends from Bits Stored.

**Adopt decision.** Adopted (AGENTS.md criteria):
- pure Rust; MIT OR Apache-2.0; no C (the `lcms2` feature, the only C, is off);
- builds for `wasm32-unknown-unknown`, including in the viewer-kit simd128 build;
- passes the corpus (below);
- 10-minute fuzz run with no crashes (STATUS);
- readable, actively maintained.

Cost: it adds about 1.5 MB to the stripped `shl-dicom-decode-wasm` module (1.14 → 2.66 MB; gzip 350 → 869 KiB). By function size the largest parts are `jxl_render` 346 KB, `jxl_modular` 291 KB, `jxl_frame` 112 KB and `brotli_decompressor` 106 KB.

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

None needed. Lossy cases differ from libjxl by at most 1: the .111 and VarDCT frames go through different floating-point IDCT and colour code.

## STATUS

- **Corpus:** 40/40 pass: 21 lossless (.110; 19 from seeds, 2 real) exact, 15 .112 and 4 .111 within 1 of libjxl.
- **Fuzz:** `cargo-fuzz` target `decode` in `codecs/shl-codec-jpegxl/fuzz` (FrameInfo from the input's own header). 10 minutes, 4 processes, no sanitizer (`RUSTC_BOOTSTRAP=1 cargo-fuzz run -O -s none decode`, seeded with the corpus frames): 1.26 million inputs, no crashes, timeouts or out-of-memory.
- **Tests:** `cargo test`, `cargo clippy --all-targets -D warnings`, and a `wasm32-unknown-unknown` build succeed.
