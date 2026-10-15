# jpeg-lossless

**Crate:** `shl-codec-jpeg (shared with jpeg-dct; one owner)`

**Specifications:** ITU-T T.81 Annex H (lossless, process 14), selection values 1–7, point transform; DICOM PS3.5 A.4.1

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2.4.57` | 77 |
| `1.2.840.10008.1.2.4.70` | 15 |

Sources: generated 88, pydicom 4. Multi-frame cases: 8. Ground truth from seeds: 88.

## Traps

- `.70` is SV1 only; `.57` allows SV1–7. The corpus has every SV from DCMTK.
- Precision 2–16 bits; the predictor resets at the start of each row and after restart markers.
- Difference category 16 (SSSS = 16) has no extra bits, and value 32768. Some 16-bit encoders get this wrong (DCMTK has a workaround option for such files); look for real files that need it.
- Signed data: DICOM encodes the stored bit pattern, so sign-extend from Bits Stored after decoding (the CLI does this; return raw samples).
- Point transform Pt > 0: shift the output left by Pt.

## Candidate crates

`jpeg-decoder` (has some lossless support; check the 16-bit and SV range), `pure_jpegli` (SV1 only, small user base), `oxiarc-jpeg`.

## Decision

**Build**, in the same crate as jpeg-dct (`shl-codec-jpeg`), sharing the marker parser, Huffman tables and bit reader. See [jpeg-dct FORMAT.md](../jpeg-dct/FORMAT.md#decision) for the crate survey.

`jpeg-decoder` 0.3 does decode all 92 lossless frames. It was not adopted, because it would still leave the 12-bit DCT path in-house, which means two JPEG front ends to maintain. The in-house lossless path is about 160 lines on top of the shared code. `zune-jpeg` fails all 92 lossless frames.

## Rulings

**`ext-gdcm-JPEGLosslessYBR_FULL_422`** (disputed): the samples are RGB, so they are returned unconverted. The label is wrong.

- **What the references do:** pylibjpeg, gdcm and dcmtk all treat the samples as YCbCr and convert them to RGB. pylibjpeg and gdcm agree exactly; dcmtk converts inside `dcmdjpeg` with its own rounding and differs by 1 on 3 pixels. That 1-off is why the case was flagged.
- **Evidence that the label is wrong:**
  - The SOF gives all three components 1×1 sampling, so the codestream has no 4:2:2 subsampling, contradicting `YBR_FULL_422`.
  - In the stored samples, R = G = B for 97.8% of pixels, and the background is (0, 0, 0). In real YCbCr, neutral pixels have Cb = Cr = 128.
  - Shown unconverted, the image is a greyscale cardiac ultrasound frame with a green ECG trace and white annotations. Converted, it becomes a green field with magenta tissue.
- **Rule** (in the codec, `LosslessDecoder::finish`): a 3-component lossless frame labelled `YBR_FULL_422`, `YBR_PARTIAL_422` or `YBR_PARTIAL_420` whose components all have the same sampling factors is returned as `ColorOut::Rgb`, unconverted.
  - Process 14 has no colour transform. A subsampled label on an unsubsampled codestream cannot describe these samples.
  - `YBR_FULL` labels are still converted by the CLI, as the references do.
- **Oracle:** the decoded samples without colour conversion, as pydicom returns them with `raw=True` (pylibjpeg or gdcm). No current reference name produces this, so the oracle needs a raw (unconverted) pydicom reference or another override mechanism.

**`ext-gdcm-MARCONI_MxTWin-12-MONO2-JpegLossless-ZeroLengthSQ`:** the entropy-coded data contains a code that matches no Huffman table entry. libjpeg's `jpeg_huff_decode` warns `JWRN_HUFF_BAD_CODE` and returns symbol 0, having read 17 bits (its `maxcode[17]` sentinel ends the search). The decoder then continues with the next sample. dcmtk and GDCM decode the file this way, giving a clean CT slice. The lossless path does the same (`lossless::diff_b`), and our output is identical to dcmtk's (oracle). The DCT path still returns `Invalid` on such a code. `Invalid` remains for structurally broken streams: a bad SOF, SOS or DHT, an over-subscribed table, or SSSS > 16.

**`ext-gdcm-MITRA_CORNELL`:** this is the Cornell 16-bit encoder bug, now handled. That encoder writes 16 extra bits after every SSSS = 16 code, where T.81 H.1.2.2 has none.

- Decoded as T.81 says, the stream soon reaches codes that match nothing. libjpeg's bad-code recovery then gives a mostly blank image, which is what plain `dcmdjpeg` produces.
- `decode_frame` therefore decodes a lossless frame a second time, with dcmtk's `--workaround-cornell` behaviour (skip 16 bits after SSSS = 16), when the first decode both used SSSS = 16 and met undecodable codes. It keeps the second result only if that decode meets no bad code at all.
- On this file the workaround decode is clean: a shoulder MRI, identical to `dcmdjpeg +wc` output (max diff 0).
- Conforming streams never trigger the retry, because they have no bad codes.
- **Oracle:** `dcmdjpeg +wc`. This needs a coordinator change, because the case is currently `expect_override: error`.

**Lossless JPEG with a JFIF marker:** no colour transform (coordinator ruling; dcmtk is the oracle for `LEADTOOLS_FLOWERS-24-RGB-JpegLossless` and `DermaColorLossLess`).

**Implementation choices:**
- **SSSS = 16:** difference 32768 with no extra bits (T.81 H.1.2.2).
- **Reconstruction:** modulo 2^16. Output is `(value << Pt) & 0xFFFF`. The CLI masks or sign-extends to Bits Stored.
- **Prediction after a restart (H.1.2.1):** the first sample of a restart interval uses 2^(P−Pt−1). Later samples on the same line use Ra, and the first sample of each later line uses Rb. This is also correct for a restart interval that does not start at column 0.
- **Colour:** lossless frames are never colour-transformed by the codec. They are returned `ColorOut::AsDeclared`, except for the subsampled-YBR-label case above.
- **Subsampled lossless components:** replicated. These are very rare, and none are in the corpus.

**Not implemented (no sample file):** dcmtk's predictor 6 overflow workaround (`+w6`). The Cornell workaround (`+wc`) is implemented, as described above.

## STATUS

**check.py:** jpeg-lossless pass=206/208, all exact (`max_abs` 0). The cases cover SV1–7 at 8, 12 and 16 bits, signed and unsigned, RGB, multi-frame and 1×1, plus the pydicom, IDC and quirk files. The two failures follow the [rulings](#rulings) above and wait for oracle changes:
- `ext-gdcm-JPEGLosslessYBR_FULL_422` needs an unconverted oracle.
- `ext-gdcm-MITRA_CORNELL` needs `dcmdjpeg +wc` as its oracle in place of `expect_override: error`.

**Tests:**
- `cargo test -p shl-codec-jpeg` includes a predictor round-trip test. It covers all 7 predictors, SSSS=16 and a restart interval that starts mid-row.
- `cargo clippy -D warnings` is clean, and the `wasm32-unknown-unknown` build succeeds.

**Speed** (release build, one core, codec only):

| Case | Size | Native | wasm simd128 | libjpeg-turbo |
|---|---|---|---|---|
| `gen-bench-dx2048-u12-ijg-lossless-sv1` | 2048×2048, 12 bits stored in 16 | 21.0 ms | 24.8 ms | 24.0 ms |
| `gen-bench-ct512-u16-ijg-lossless-sv1` | 512×512, 16-bit | 1.52 ms | 1.47 ms | 1.33 ms |

These are 3.5× and 2.8× faster than before the speed work. See [PERF.md](../jpeg-dct/PERF.md).

**Fuzzing (shared crate):** no panics, hangs or OOMs.

- **Setup:** cargo-fuzz (libFuzzer, coverage-guided, overflow checks on). The target is `shl-codec-jpeg/fuzz`, `decode`. It takes the FrameInfo from the input's own SOF, caps it at 4 Mpixel, and lets the first byte pick the photometric and Bits Allocated.
- **Seeds:** every corpus frame under 300 KB.
- **Speed-work rerun (October 2026, after the SIMD and entropy changes):** 5 minutes × 4 workers, seeded with 700 random corpus frames under 300 KB, about 216,000 executions and 869 coverage edges, with no findings. Run-time detection selected the AVX2 kernels, so they were fuzzed too.
- **Runs:**
  - 12 minutes × 4 workers on inputs up to 300 KB: about 575,000 executions, 585 coverage edges.
  - 3 minutes × 4 workers on inputs up to 4 KB: about 1.13 million executions, 606 edges.
- **Build note:** the local nightly is from 2023 and too old for this crate, so the build uses the stable toolchain without a sanitizer:
  `RUSTC_BOOTSTRAP=1 cargo +stable fuzz run -s none decode <corpus>`
