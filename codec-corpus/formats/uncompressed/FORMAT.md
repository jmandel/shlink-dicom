# uncompressed

**Crate:** none; handled in `shl-dicom-decode` (phase 0)

**Specifications:** DICOM PS3.5 §8 (native pixel data), §7.3 (byte order), Annex A.1–A.5 (transfer syntaxes, including Deflated)

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2` | 46 |
| `1.2.840.10008.1.2.1` | 159 |
| `1.2.840.10008.1.2.1.99` | 12 |
| `1.2.840.10008.1.2.2` | 23 |

Sources: external quirk sets 89, IDC 72, pydicom 61, generated 18. Multi-frame cases: 47. Ground truth from seeds: 18.

The four Deflated cases were added in phase 0: `pydicom-image_dfl` (pydicom's test file, which `discover.py` skipped because the uncompressed budget of 60 was already used) and `gen-synth-{u16-3frame-32x32,rgb8-60x40,s12-40x40}-deflate` (seeds re-saved by pydicom as Deflated Explicit VR Little Endian, truth = seed). They were registered by calling `discover.register` and `generate.register` from a one-off script, because neither script can express them yet. To make them reproducible, the coordinator should add a `pydicom-deflate` encoder for these seeds to `generate.py` and either raise the `discover.py` budget or allow-list `image_dfl.dcm`.

Expected to be refused (exit 2): `pydicom-MR_truncated` and the two Orthanc `oob-monochrome` files. Three more are expect=error today but should change (see STATUS): `ext-fodicom-GH1376`, `ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix` and `ext-gdcm-MR16BitsAllocated_8BitsStored`.

## Traps

- Explicit VR Big Endian: 16- and 32-bit samples are byte-swapped; 8-bit samples are not.
- Bits Allocated 1 (bit-packed) and pixel data that isn't byte-aligned (see `pydicom-liver_nonbyte_aligned`).
- Bits Allocated 32, signed data with Bits Stored < Bits Allocated (sign extension), and padding bits above High Bit that must be masked.
- Planar Configuration 1 (colour planes stored separately) and uncompressed YBR_FULL (convert to RGB).
- Odd-length pixel data with a trailing pad byte; a frame count that doesn't divide the data evenly.
- Deflated Explicit VR Little Endian (1.2.840.10008.1.2.1.99): the whole dataset after the file meta is raw deflate (no zlib header).
- YBR_FULL_422 native data stores two samples per pixel (Y1 Y2 Cb Cr per pixel pair), so a frame holds 2/3 of the bytes an RGB frame would.

## Candidate crates

dicom-rs (`dicom-object`, `dicom-pixeldata`) for parsing; `miniz_oxide`/`flate2` (rust backend) for deflate.

## Decision

**Built in `shl-dicom-decode`, with a small DICOM reader of its own instead of dicom-rs.** The only new dependency is `miniz_oxide` (pure Rust, MIT/Apache/zlib) for inflate.

dicom-rs (`dicom-object` 0.10, default features off) is pure Rust and would build, but it did not fit this job:
- **Allocation.** `dicom-parser` allocates each element's declared length before reading it (`smallvec![0; len]`, `resize_with`). A crafted 4-byte length can therefore ask for up to 4 GiB, which aborts on wasm32. The reader here only slices the in-memory input, so a declared length beyond the data is an `Invalid` error, never an allocation.
- **Raw bytes.** dicom-rs decodes OW to `u16` in the transfer syntax's byte order. Matching pydicom needs the bytes as they are in the file: 32-bit samples in Explicit VR Big Endian, the pairwise swap of 8-bit OW data, and odd lengths.
- **File layouts.** It needs custom handling for files that start with the group 0002 meta and no `DICM` (several jpeg-ls cases), and for bare data sets whose encoding has to be guessed. That is most of the work a reader needs anyway.
- **Size.** The decoder becomes the WASM pixel path in phase 3. Without dicom-rs it carries no extra crates (`encoding`, `tracing`, `snafu`, `itertools` and so on).

The reader handles:
- a preamble plus `DICM`, `DICM` at offset 0, meta with no `DICM`, and bare data sets (guessed the way pydicom guesses them);
- Implicit and Explicit VR Little Endian, Explicit VR Big Endian, and Deflated;
- defined- and undefined-length sequences, nested up to 64 deep, including explicit-VR items that switch to implicit VR, and undefined-length UN;
- encapsulated items, including encapsulated data stored under a defined length.

It reads only the top-level Image Pixel attributes, stops after Pixel Data, and never panics on input-derived data (see STATUS for the fuzz run).

## Rulings

No case in this format is disputed. These are the rulings on edge cases, and where each comes from. Unless stated otherwise the behaviour is pydicom 3's (`pixel_array(raw=False)`, the oracle).

1. **Short pixel data is invalid (exit 2); extra bytes are ignored.**
   - Native Pixel Data must hold `frames × frame bytes` (bit-packed data: `ceil(total pixels / 8)`). If it is shorter, the file is refused. This is why `pydicom-MR_truncated` exits 2.
   - Trailing padding and excess bytes are ignored. pydicom's `allow_excess_frames` can return *more* frames than Number of Frames when the excess holds whole frames. We return exactly Number of Frames, as the oracle's reshape does.
2. **Number of Frames.** Missing, empty or 0 means 1, as in pydicom. A negative or non-numeric value is invalid.
3. **Required attributes, as pydicom requires them:**
   - Rows, Columns, Bits Allocated, Bits Stored, Pixel Representation and Photometric Interpretation;
   - Planar Configuration when Samples per Pixel is 3.

   If any is missing, the file is invalid (exit 2). One exception: a missing **Samples per Pixel means 1**, as GDCM assumes (`ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix`, a MONOCHROME2 CR). pydicom refuses that file, so its case should become expect=decode. The following are also invalid:
   - Bits Allocated that is 0, more than 64, or not 1 or a multiple of 8;
   - Bits Stored of 0 or more than Bits Allocated;
   - Samples per Pixel other than 1 or 3;
   - Pixel Representation or Planar Configuration other than 0 or 1.

   Bits Allocated 24, 40, 48 or 64 is unsupported (exit 3): the contract has no sample type for them.
4. **Explicit VR Big Endian:**
   - 16- and 32-bit samples are byte-swapped.
   - 8-bit samples in an **OW** element are swapped pairwise first. pydicom's `be_swap_ow` handles the same layout, which some big endian writers produce.
   - 8-bit samples in OB, and all Bits Allocated 1 data (including `pydicom-liver_expb`), are not swapped. This follows pydicom, which only swaps when `Bits Allocated // 8 == 1`.
5. **Bits Allocated 1.** Frames are packed back to back with no padding between them, least significant bit first (PS3.5 8.1.1). The output is one byte per pixel, 0 or 1. Masking does not apply.
6. **Unused high bits.** When Bits Stored < Bits Allocated, the stored value is masked (unsigned) or sign-extended from bit `Bits Stored − 1` (signed). This is applied after the byte swap and planar interleave and before colour conversion, the same order as pydicom.
7. **YBR_FULL_422 (native).** Each Y1 Y2 Cb Cr group is expanded to two YBR_FULL pixels, over the whole buffer, as pydicom does: a pair may span rows. YBR_FULL is then converted to RGB.
   - The conversion matches pydicom's `_convert_YBR_FULL_to_RGB` bit for bit: float32, matrix entries computed in float64 and stored as float32, `floor(x + 0.5)`, then a clamp to 0–255.
   - Only unsigned 8-bit YBR is converted. pydicom raises an error for other widths, so we return unsupported (exit 3).
8. **Colour spaces that are not converted.** YBR_PARTIAL_*, YBR_ICT and YBR_RCT are not converted for native data, because pydicom does not convert them. They are not valid for native transfer syntaxes anyway. PALETTE COLOR stays as indices and MONOCHROME1 is not inverted.
9. **Encoding that contradicts the transfer syntax is invalid.** For example, an implicit VR data set in a file whose meta declares an explicit syntax.
   - pydicom's `dcmread` switches encoding with a warning. Its pixel path, gdcm and dcmtk all refuse such a file; that is why `pydicom-SC_rgb_jpeg` in jpeg-dct is expect=error.
   - So we refuse it too (exit 2).
   - The check is on the first element of the top-level data set, which is where pydicom's `_is_implicit_vr` decides.
   - Single elements written in implicit VR inside an explicit VR data set are a different matter; see ruling 11.
10. **Bare data sets** (no meta) are read with the encoding guessed from the first element, the way pydicom guesses: a known VR at bytes 4–6 means explicit, and a group ≥ 1024 read little-endian means big endian. Data sets that start with the group 0002 meta but have no preamble or `DICM` are read as Part 10.
11. **One element in implicit VR inside an explicit VR data set** is re-read as implicit, and reading goes on. pydicom decides this per element, in `data_element_generator`:
    - if the two VR bytes are outside `AA`..`ZZ` (byte-wise), it assumes implicit VR for that element (`assume_implicit_vr_switch`), so the VR bytes and the 2 bytes after them are a 4-byte length;
    - VR bytes inside that range but not a known VR are read as explicit with a 2-byte length.

    We do the same at any depth. This covers both cases:
    - `ext-gdcm-DMCPACS_ExplicitImplicit_BogusIOP`: (0008,0080) at the top level;
    - `ext-gdcm-TheralysGDCM120Bug`: (2005,1406) inside a Philips private sequence item, not its first element.

    GDCM does the same. Ruling 9 still refuses a data set whose first element is in the wrong VR.
12. **Stray item tags at the top level.** An (FFFE,xxxx) tag among the top-level elements (fo-dicom #364, `ext-fodicom-GH364` in jpeg-ls) is skipped by its stated length, as pydicom does. With undefined length it is invalid.
13. **Group 0002 after the file meta.** The meta header ends at the first element that is not in group 0002 or whose tag does not increase. Group 0002 elements in the data set are ignored: PS3.10 §7.1 places group 0002 only in the meta header, and dcmtk ignores later copies too.

    In `ext-fodicom-GH1376` the real meta says JPEG Lossless SV1, and a second group 0002 block straight after it says Explicit VR Little Endian. pydicom takes the second, so the case was filed here with expect=error. We now decode it as JPEG Lossless, and it should move to jpeg-lossless with a dcmtk oracle.
14. **Refusal messages.** A transfer syntax without a codec is refused (exit 3) before the data set is read, with the encoding named. For example: "MPEG-2 video (Main Profile / Main Level) (1.2.840.10008.1.2.4.100) is not supported; this decoder has no codec for it".

    The named syntaxes are:
    - video: MPEG-2, H.264 and HEVC;
    - JPEG XL;
    - the retired progressive, arithmetic-coded and hierarchical JPEG processes;
    - JPEG 2000 Part 2 and JPIP;
    - Encapsulated Uncompressed and Deflated Image Frame Compression;
    - RFC 2557 and SMPTE ST 2110;
    - the GE private Implicit VR Big Endian syntax.

    Float and Double Float Pixel Data without integer Pixel Data are refused with "float pixel data not supported", before any check for Bits Stored.

## STATUS

**Foundation agent, 2026-10-14 (IDC and quirk-set round). uncompressed: pass=237 / 240.** The 3 failures are expectation changes for the coordinator; the decoder's output is believed right for all three:

| Case | Today | Should be |
|---|---|---|
| `ext-fodicom-GH1376` | expect=error; we decode | Re-register under jpeg-lossless with a dcmtk oracle (ruling 13). |
| `ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix` | expect=error; we decode with Samples per Pixel 1 | expect=decode; GDCM's output is the oracle (ruling 3). |
| `ext-gdcm-MR16BitsAllocated_8BitsStored` | expect=error; we decode | Photometric "MONOCHROME" is not a defined term, and pydicom refuses it on the name alone. We decode it as monochrome. It needs a hand-checked oracle (QUIRKS.md). |

Full `check.py --name foundation`, before and after this round. Both runs use the codec crates as they stood at the time, and the jpeg crate changed between the runs:

| Format | Before | After |
|---|---|---|
| uncompressed | fail=3 pass=237 | fail=3 pass=237 (2 fixed, 2 newly decoded expect=error cases) |
| rle | fail=1 pass=52 | pass=53 |
| jpeg-dct | fail=5 pass=134 | pass=139 |
| jpeg-lossless | fail=2 pass=205 | fail=2 pass=205 |
| jpeg-ls | fail=1 pass=68 | pass=69 |
| jpeg2000 | fail=1 pass=165 | pass=166 |
| htj2k | pass=27 | pass=38 |

Fixed by this round's CLI changes:
- the 5 IDC Mirax jpeg-dct cases (invalid EOT, fallback);
- `ext-gdcm-00191113` (invalid BOT, fallback);
- `ext-fodicom-GH364` (stray item);
- `ext-gdcm-DMCPACS_ExplicitImplicit_BogusIOP` and `ext-gdcm-TheralysGDCM120Bug` (per-element VR);
- `ext-gdcm-Osirix10vs8BitsStored` (JPEG 2000 precision; see CONTRACT.md).

The remaining fixes came from the codec agents' work during the same period.

The two jpeg-lossless failures after this round are `ext-gdcm-JPEGLosslessYBR_FULL_422` (disputed) and `ext-gdcm-MITRA_CORNELL` (expect=error, now decoded). Both are single-fragment, single-frame files with an empty Basic Offset Table and an ordinary meta, so none of this round's CLI changes reach them. They come from the jpeg crate, which was being edited during the run.

No crashes. No case is unsupported.

Tests (`cargo test -p shl-dicom-decode`):
- 20 unit tests, covering the reader, frame splitting with offset-table validation, and the sample transforms;
- 28 end-to-end tests on DICOM files built in memory:
  - the 19 from phase 0;
  - one each for an Extended Offset Table whose lengths include the item header, a Basic Offset Table that does not land on items, a stray top-level item, per-element implicit VR (top level and inside an item), a whole data set in the wrong VR (still refused), duplicate group 0002, JPEG 2000 precision versus Bits Stored, named refusals (MPEG-2, GE private, float pixel data) and missing Samples per Pixel.

  The encapsulated tests use fake codecs injected through `decode_file_with`.

Other checks:
- `cargo clippy -p shl-dicom-decode --no-deps --all-targets -- -D warnings`: clean. `--no-deps` is needed because a full clippy run also lints the codec crates, and the jpeg crate's in-progress code currently fails it.
- wasm32: `~/.cargo/bin/cargo +stable build --target wasm32-unknown-unknown -p shl-dicom-decode --lib` builds. The system `/usr/bin/cargo` has no wasm32 standard library.

Fuzzing: `SHL_FUZZ_ITERS=300000 cargo test --release --test synthetic mutated` (corpus mutations with a zero-filling fake codec) found no panics, hangs or large allocations. No `cargo fuzz` target yet.

Normalisation speed (2026-10-15). The output is unchanged; `check.py` passed every case in every format afterwards (918 cases, uncompressed 243).
- **Planar to interleaved:** 3 × 8-bit and 3 × 16-bit samples go through a block loop on fixed-size arrays, written straight into the output buffer. Other layouts use the generic path.
- **YBR_FULL → RGB:**
  - R and B come from two 64 KiB tables indexed by (Y, Cr) and (Y, Cb), built once with the float32 formula.
  - G stays in float32, in numpy's order, with the products looked up per 8-bit input.
  - Rounding is `(x + 0.5).clamp(0, 255) as u8` instead of `floor`, which is the same byte for every x and needs no libm call.
  - Unsigned 8-bit interleaved YBR_FULL_422 with Bits Stored 8 is expanded and converted in one pass.
  - The test `ybr_matches_reference_on_all_inputs` checks the result against pydicom's float32 formula on all 2^24 inputs.
- **Masking and sign extension:** loops per width, with no per-sample bounds checks.

Bench medians (ms), before → after:

| Case | native | wasm-simd |
|---|---|---|
| RLE RGB cine 640×480×30 | 108 → 8.0 | 144 → 14.3 |
| RLE RGB 1475² planar | 24.9 → 3.7 | 36.0 → 5.8 |
| uncompressed YBR_FULL_422 576×456×24 | 106 → 11.4 | 135 → 23.8 |
| uncompressed RGB cine | 2.76 → 1.59 | 2.83 → 1.62 |

Known gaps:
- Float and Double Float Pixel Data are unsupported (exit 3).
- Bits Allocated other than 1, 8, 16 or 32 is unsupported.
- Nothing is read after the top-level Pixel Data element.
