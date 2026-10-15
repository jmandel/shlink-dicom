# Decoder contract

Every decoder checked against this corpus, reference or candidate, is a command that takes a DICOM file and writes its decoded pixels in one canonical form. `scripts/check.py` runs the command once per case.

## Command

```
<decoder> IN.dcm OUT.raw
```

| Exit code | Meaning |
|---|---|
| 0 | Decoded. `OUT.raw` holds every frame in canonical form. |
| 2 | Refused: the file is malformed or violates the standard. Print one line to stderr saying why. |
| 3 | Unsupported: valid, but this decoder does not handle it yet (for example, a transfer syntax not yet implemented). Print one line to stderr. |
| anything else, a signal, or exit 101 (a Rust panic) | Crash. Always a bug, even on garbage input. |

A decoder must finish each case within 60 seconds, which is `check.py --timeout`. The corpus files are small, so anything near that limit is a bug.

## Canonical pixels

- **Layout:** all frames, then rows, then columns, then samples per pixel: shape `(frames, rows, columns, samples)`, in C order with samples interleaved. When the file uses Planar Configuration 1 (planes stored separately), the decoder interleaves them.
- **Sample type:** an integer the width of Bits Allocated (8, 16 or 32), little-endian. It is unsigned when Pixel Representation is 0 and signed when it is 1.
- **Values:** the stored values. When Bits Stored is less than Bits Allocated (for JPEG 2000 and HTJ2K, use the larger of Bits Stored and the codestream's precision for that component, as pydicom does; ruling on `ext-gdcm-Osirix10vs8BitsStored`):
  - unsigned values keep only the low Bits Stored bits;
  - signed values are sign-extended from bit `Bits Stored − 1`.

  Never apply Rescale Slope/Intercept, the Modality LUT, the VOI LUT or windowing.
- **Colour:**
  - `YBR_FULL`, `YBR_FULL_422`, `YBR_PARTIAL_422`, `YBR_ICT` and `YBR_RCT` are converted to RGB.
  - For JPEG and JPEG 2000 this usually happens inside the codec: the colour transform in the codestream, or the decoder's YCbCr output converted back.
  - `PALETTE COLOR` stays as indices, and `MONOCHROME1` is not inverted.
- **Order:** frames in file order. For encapsulated data, the frame boundaries come from the Basic or Extended Offset Table when present; otherwise from fragments, one frame per fragment when the counts match.

This is what pydicom returns from `pixel_array(path, raw=False)`. `scripts/ref_decode.py` is the reference implementation of the contract.

## What counts as correct

Each case in `formats/<fmt>/cases.json` carries:

| Field | Meaning |
|---|---|
| `expect` | `decode`, or `error` when no reference decoder can read the file. For `error`, exit 2 passes and exit 3 counts as unsupported. |
| `max_abs` | Largest allowed per-sample difference from the oracle: 0 for lossless syntaxes; for lossy syntaxes, at least 1 and at least the largest disagreement between reference decoders. |
| `truth` | `seed` when the oracle is the known input to the encoder (generated lossless cases); otherwise the oracle comes from reference decoders. |
| `confidence`, `disputed` | How much the oracle can be trusted. A disputed case is one where references disagree on a lossless file; it needs a human or agent ruling recorded in that format's `FORMAT.md`. |

## Writing a candidate

The Rust candidate is the `shl-dicom-decode` binary in `../codecs/`. Any other candidate, such as a crate being evaluated, can be wrapped in a small binary or script that follows the same command contract:

```
uv run python scripts/check.py --name <label> --candidate "<command> {in} {out}" [--format <fmt>]
```

## How the CLI calls codecs

`shl-dicom-decode` (`decode_file` in its library) does all the DICOM work. A codec only turns one frame's codestream into samples.

**1. Frames.** The CLI splits encapsulated Pixel Data into one codestream per frame, choosing the method in this order (the same order as pydicom):

1. the Extended Offset Table, when both (7FE0,0001) and (7FE0,0002) are present with equal counts, every offset is the start of a fragment item, and every length fits in that fragment;
2. the Basic Offset Table, when it is not empty, its entries strictly increase, and every entry is the start of a fragment item;
3. one fragment, which is one frame;
4. one frame per fragment, when the counts match;
5. all fragments joined, when Number of Frames is 1;
6. with more fragments than frames, a frame ends at each fragment whose last 10 bytes contain `FF D9`.

An offset table that fails these checks is ignored, and the next method is used, as the references do. Two real cases: pydicom 3.0.1 writes EOT lengths that include the 8-byte item header (IDC Mirax slides), and some writers count 9 bytes per item in the BOT (GDCM's `00191113.dcm`).

Fewer frames than Number of Frames is exit 2. Each codestream is the fragments joined; any trailing pad byte is still there.

**2. Call.** `decode_frame(codestream, &info)` is called once per frame, in order. `FrameInfo` holds the data set's values unchanged: Photometric Interpretation as declared, Planar Configuration as declared (0 when Samples per Pixel is 1), and the transfer syntax UID. `Unsupported` becomes exit 3 and `Invalid` becomes exit 2; the first frame error stops the decode.

**3. Output size.** `DecodedFrame.data` must be exactly `info.frame_bytes()` long (rows × columns × samples × bytes per sample). Anything else is exit 2. Bits Allocated 1 means one byte per sample.

**4. Normalisation.** The CLI then normalises each frame, in this order:

1. **Planar:** if `planar` is true, the planes are interleaved.
2. **Bits Stored:** when Bits Stored < Bits Allocated, samples are masked (unsigned) or sign-extended (signed). So a codec may leave junk or sign bits above Bits Stored, but it must put the value in the low bits, and samples must be little-endian.

   For JPEG 2000 and HTJ2K (1.2.840.10008.1.2.4.90, .91, .201, .202, .203), each component keeps max(Bits Stored, the SIZ precision of that component) bits. The CLI reads the precision itself from the frame's codestream: SOC FF4F followed by SIZ FF51, possibly inside a JP2 wrapper, found by searching the first 4 KiB. Csiz is 38 bytes after the SIZ marker, component k's Ssiz is at 40 + 3k, and precision = (Ssiz & 0x7F) + 1. For example, in `ext-gdcm-Osirix10vs8BitsStored` SIZ says 10 and Bits Stored says 8, and the 10-bit values are kept, as pydicom keeps them. A JPEG 2000 codec should therefore return the full decoded component values and not mask them to Bits Stored itself.
3. **Colour**, depending on `color` and the declared photometric:
   - `Rgb`: no conversion. Use it whenever the codec undid a colour transform: JPEG YCbCr, JPEG 2000 RCT/ICT, or a JPEG-LS colour transform.
   - `AsDeclared` with YBR_FULL or YBR_FULL_422: converted to RGB exactly as pydicom does (float32 matrix, `floor(x + 0.5)`, clamp). Unsigned 8-bit only; other widths are exit 3. Use this for RLE YBR_FULL.
   - `AsDeclared` with YBR_PARTIAL_420, YBR_PARTIAL_422, YBR_ICT or YBR_RCT and 3 samples: exit 3. The codec must return RGB for these.
   - `AsDeclared` with any other photometric: no conversion.

**5. Sign.** pydicom does not treat signedness the same way for every codec, and the CLI does not reproduce these special cases, so the codec must:
- JPEG-LS: pydicom sign-extends signed data from the JPEG-LS precision, not from Bits Stored, and leaves unsigned data unmasked.
- JPEG 2000: pydicom corrects only a mismatch between the codestream's signedness and Pixel Representation, and only for MONOCHROME images.

Because the CLI masks afterwards (to Bits Stored, or for JPEG 2000 to the larger of Bits Stored and the SIZ precision), these differences matter only when the codestream precision differs from Bits Stored. A codec agent who finds such a case records it in their FORMAT.md.

**Testing a codec without the CLI's dispatch.** `shl_dicom_decode::decode_file_with(bytes, |ts| ...)` takes a codec table instead of `codec_for`, so a candidate crate can be tried without editing `shl-dicom-decode`.

## Reduced-resolution decode

A thumbnail or a first display does not need every pixel. A codec that can reconstruct a smaller image directly (JPEG through scaled inverse DCTs, JPEG 2000 by skipping resolution levels) does much less work than a full decode followed by a downsample. This section defines that optional path. It is additive: `decode_frame` and everything above are unchanged.

**Scale.** `scale_log2 = s` asks for 1/2^s of the size in each direction. The result is `ceil(rows / 2^s)` × `ceil(columns / 2^s)` (`shl_codec_common::scaled_extent`), which is libjpeg's output size for `scale_denom = 2^s` and OpenJPEG's for `reduce = s` on an image whose origin is (0, 0). `s = 0` is a full decode.

**Codec side.** A codec with a reduced decode exports

```rust
pub fn decode_frame_scaled(codestream: &[u8], info: &FrameInfo, scale_log2: u8) -> Result<DecodedScaled>;
// shl_codec_common::DecodeScaledFn; DecodedScaled { frame: DecodedFrame, rows, columns }
```

- **Input and output rules.** `info` is the same full-size `FrameInfo` that `decode_frame` gets. The output follows every rule for `decode_frame` output (sample layout, Bits Allocated width, `planar`, `color`, junk above Bits Stored allowed) at `rows` × `columns`. `frame.data` is exactly `rows × columns × samples × bytes per sample` long, and `rows` and `columns` are exactly the sizes above. Anything else is exit 2.
- **Values.** They are the codec's own reduced reconstruction, not a downsample of its full output:
  - JPEG: libjpeg-turbo's scaled decode.
  - JPEG 2000 and HTJ2K: the image rebuilt from the lower resolution levels, as OpenJPEG's `reduce` rebuilds it.

  Both are close to a block average of the full decode, but not equal to it.
- **Unsupported.** `Unsupported` means "no reduced decode at this scale". Use it, for example, when the scale exceeds the codec's reductions, or the codestream has fewer resolution levels than `s`. Also use it when the codec's reduced grid differs from the sizes above: a JPEG 2000 image or tile origin that is not a multiple of 2^s gives `ceil(x1 / 2^s) − ceil(x0 / 2^s)` samples, which can differ by one. The caller then falls back.
- **Invalid** means a malformed codestream, as for `decode_frame`.
- **No reduced decode.** A codec without one exports nothing, or uses `shl_codec_common::decode_scaled_unsupported`.

**CLI side.** `shl-dicom-decode` provides `decode_file_scaled(bytes, s)`, and the binary takes `--scale S`, which also prints `COLUMNS ROWS` of the result. It returns canonical pixels at the reduced size, in the same form as `decode_file`. For each frame it tries these in order:

1. The codec's reduced decode at `s` (`scaled_codec_for` lists the codecs that have one).
2. Otherwise, the codec's reduced decode at the largest `k < s` it supports, followed by a box downsample by 2^(s−k).
3. Otherwise, a full `decode_frame` and a box downsample by 2^s.

Before any downsampling, each codec result is normalised at the size it was decoded at: planar, Bits Stored and colour, exactly as above. So the fallback averages canonical values: RGB, masked or sign-extended. If the reduced decode returns `Invalid`, the frame is decoded again at full size, so the scaled path never refuses a frame that `decode_file` accepts.

**Box downsample** (the fallback, applied outside the codec):

- Each output sample is `floor(mean + 1/2)` of its 2^s × 2^s block, per sample (channel), with signed values averaged as signed.
- Blocks at the right and bottom edges average only the samples they have.
- PALETTE COLOR is never averaged, because averaging indices is meaningless. The fallback takes each block's top-left sample, and a codec's reduced decode is not used.
- Native (uncompressed) data always takes the fallback.

**JPEG (`shl-codec-jpeg`).**

- **Scales.** Baseline and extended DCT, 8 and 12-bit, at s = 1, 2, 3. Larger `s` returns Unsupported, so the CLI decodes at 1/8 and box-downsamples the rest. Lossless JPEG returns Unsupported at every s > 0.
- **Output.** Identical to libjpeg-turbo 3.x with `scale_num = 1, scale_denom = 2^s` and default settings (`JDCT_ISLOW`, fancy upsampling):
  - the reduced IDCTs of `jidctred.c` (4×4, 2×2 and 1×1 from each 8×8 block);
  - a subsampled component gets a larger IDCT where that replaces upsampling (4:2:0 chroma needs no upsampling at any reduced scale);
  - upsampling at the reduced size, with no fancy upsampling at 1/8;
  - colour conversion as in full decode.
- **Checked by** `formats/jpeg-dct/scaled/check_scaled.py`, which compares every corpus frame at every scale against libjpeg-turbo, for 8-bit and 12-bit.
- **One known difference.** For 4:4:0 sampling (h1v2) libjpeg-turbo uses a fancy vertical upsampler, while this decoder replicates rows, as IJG 6b does. No corpus case has 4:4:0.
