# uncompressed

**Crate:** none; handled in `shl-dicom-decode` (`lib.rs`, `float.rs`, `unwrapped.rs`, `retired.rs`)

**Specifications:** DICOM PS3.5 §8 (native pixel data), §7.3 (byte order), Annex A.1–A.5 (transfer syntaxes, including Deflated), A.4.11 and A.4.13 (Encapsulated Uncompressed, Deflated Image Frame Compression); PS3.3 C.7.6.3 (Image Pixel module, including Float and Double Float Pixel Data, and the retired photometric interpretations up to the 2003 edition)

## Corpus

| Transfer syntax | Cases |
|---|---|
| `1.2.840.10008.1.2` | 57 |
| `1.2.840.10008.1.2.1` | 202 |
| `1.2.840.10008.1.2.1.99` | 12 |
| `1.2.840.10008.1.2.2` | 25 |
| `1.2.840.10008.1.2.1.98` | 10 |
| `1.2.840.10008.1.2.8.1` | 11 |
| `1.2.840.113619.5.2` | 2 |

Sources: external quirk sets 104, IDC 80, pydicom 61, generated 56, repaired copies 10, stripped copies 8. Multi-frame cases: 58. Ground truth from seeds: 18. Ten cases have no Part 10 meta (tag `no-part10-meta`).

The four Deflated cases were added in phase 0: `pydicom-image_dfl` (pydicom's test file, which `discover.py` skipped because the uncompressed budget of 60 was already used) and `gen-synth-{u16-3frame-32x32,rgb8-60x40,s12-40x40}-deflate` (seeds re-saved by pydicom as Deflated Explicit VR Little Endian, truth = seed). They were registered by calling `discover.register` and `generate.register` from a one-off script, because neither script can express them yet. To make them reproducible, the coordinator should add a `pydicom-deflate` encoder for these seeds to `generate.py` and either raise the `discover.py` budget or allow-list `image_dfl.dcm`.

Expected to be refused (exit 2): `pydicom-MR_truncated` and the two Orthanc `oob-monochrome` files. Three more are expect=error today but should change (see STATUS): `ext-fodicom-GH1376`, `ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix` and `ext-gdcm-MR16BitsAllocated_8BitsStored`.

## Traps

- Explicit VR Big Endian: 16- and 32-bit samples are byte-swapped; 8-bit samples are not.
- Bits Allocated 1 (bit-packed) and pixel data that isn't byte-aligned (see `pydicom-liver_nonbyte_aligned`).
- Bits Allocated 32, signed data with Bits Stored < Bits Allocated (sign extension), and padding bits above High Bit that must be masked.
- Planar Configuration 1 (colour planes stored separately) and uncompressed YBR_FULL (convert to RGB).
- Odd-length pixel data with a trailing pad byte; a frame count that doesn't divide the data evenly.
- Deflated Explicit VR Little Endian (1.2.840.10008.1.2.1.99): the whole dataset after the file meta is raw deflate (no zlib header).
- YBR_FULL_422 and YBR_PARTIAL_422 native data store two samples per pixel (Y1 Y2 Cb Cr per pixel pair), so a frame holds 2/3 of the bytes an RGB frame would.
- Float and Double Float Pixel Data (7FE0,0008/0009) replace Pixel Data and have no Bits Stored or Pixel Representation.
- Encapsulated Uncompressed and Deflated Image Frame frames each start on a byte boundary, also for Bits Allocated 1, where native data packs frames back to back.
- The GE private syntax has a little endian data set and big endian Pixel Data.

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
3. **Missing or impossible Image Pixel attributes are inferred where the evidence settles them, and refused otherwise.** pydicom refuses every such file. The decoder fills in a value only from evidence in the file itself. Each value it fills in is reported in `Canonical::inferred` and printed by the CLI as `note: inferred NAME = VALUE: reason` on stderr; the exit code is still 0. Rule 15 has the full list. These are refused (exit 2):
   - Samples per Pixel other than 1 or 3;
   - Pixel Representation other than 0 or 1;
   - Planar Configuration other than 0 or 1 on native 3-sample data;
   - on native data, Bits Allocated present but not 1, 8, 16 or 32, except the ACR-NEMA forms of rule 19.

   Other Bits Allocated values (24 with Samples per Pixel present, 40, 48, 64) are unsupported (exit 3), because the contract has no integer sample type for them.
4. **Explicit VR Big Endian:**
   - 16- and 32-bit samples are byte-swapped.
   - 8-bit samples in an **OW** element are swapped pairwise first. pydicom's `be_swap_ow` handles the same layout, which some big endian writers produce.
   - 8-bit samples in OB, and all Bits Allocated 1 data (including `pydicom-liver_expb`), are not swapped. This follows pydicom, which only swaps when `Bits Allocated // 8 == 1`.
5. **Bits Allocated 1.** Frames are packed back to back with no padding between them, least significant bit first (PS3.5 8.1.1). The output is one byte per pixel, 0 or 1. Masking does not apply.
6. **Unused high bits.** When Bits Stored < Bits Allocated, the stored value is masked (unsigned) or sign-extended from bit `Bits Stored − 1` (signed). This is applied after the byte swap and planar interleave and before colour conversion, the same order as pydicom.
7. **YBR_FULL_422 (native).** Each Y1 Y2 Cb Cr group is expanded to two YBR_FULL pixels, over the whole buffer, as pydicom does: a pair may span rows. YBR_FULL is then converted to RGB.
   - The conversion matches pydicom's `_convert_YBR_FULL_to_RGB` bit for bit: float32, matrix entries computed in float64 and stored as float32, `floor(x + 0.5)`, then a clamp to 0–255.
   - Only unsigned 8-bit YBR is converted. pydicom raises an error for other widths, so we return unsupported (exit 3).
8. **Colour spaces.** YBR_PARTIAL_422 and the retired ARGB, CMYK and HSV are converted to RGB (rule 20). YBR_PARTIAL_420 on native data is unsupported (exit 3): the standard defines it only inside MPEG-2, H.264 and HEVC streams. YBR_ICT and YBR_RCT are left as they are, since they belong to JPEG 2000. PALETTE COLOR stays as indices and MONOCHROME1 is not inverted.
9. **Encoding that contradicts the transfer syntax is invalid.** For example, an implicit VR data set in a file whose meta declares an explicit syntax.
   - pydicom's `dcmread` switches encoding with a warning. Its pixel path, gdcm and dcmtk all refuse such a file; that is why `pydicom-SC_rgb_jpeg` in jpeg-dct is expect=error.
   - So we refuse it too (exit 2).
   - The check is on the first element of the top-level data set, which is where pydicom's `_is_implicit_vr` decides.
   - Single elements written in implicit VR inside an explicit VR data set are a different matter; see ruling 11.
10. **Bare data sets** (no meta) are read with the encoding guessed from the first element, the way pydicom's `dcmread(force=True)` guesses: a known VR at bytes 4–6 means explicit, and a group ≥ 1024 read little-endian means big endian. Data sets that start with the group 0002 meta but have no preamble or `DICM` are read as Part 10. `discover.register` and `ref_decode.read` give such a file the transfer syntax pydicom guessed, so it is registered and decoded by the references like any other (tag `no-part10-meta`).
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
    - JPIP;
    - RFC 2557 and SMPTE ST 2110.

15. **Inference rules.** Each fills in one attribute and records why. Evidence comes from the codestream header (JPEG and JPEG-LS SOF, JPEG 2000 SIZ), from the Pixel Data length, or from the pixels themselves.

    **Implemented:**

    | Attribute | When | Value used | Evidence |
    |---|---|---|---|
    | Planar Configuration | missing, on native 3-sample data (not YBR_FULL_422 and not 1-bit) | whichever layout is clearly smoother: mean absolute difference between horizontally and vertically adjacent samples of a channel, summed. The smoother reading must win by at least 1.25×. Refused if the margin is smaller, or the image is under 16×16 pixels or under 4 pixels in either direction; decoded either way if both readings give the same pixels | Long-tail IDC sweep: 8 RGB files without the attribute, all refused by pydicom, GDCM and dcmtk. The 2 Philips IntelliSpace Portal files read as a clean CT montage only when planar (interleaved, they tile 3×3). The 6 GE LOGIQ E9 US files read cleanly only when interleaved. The score picks the right layout for all 8, by margins of 1.77× to 8.4×. Stripped copies of 14 existing RGB cases came out right for 13; the 14th, a 3×3 image, is why the minimum size exists. Cases: `idc-lt-model-intellispace-p-310c4091` (planar), `idc-lt-planar-3-absent-4eca9830` (interleaved), `strip-pc-*` (7 decode, 1 refused as too small). |
    | Planar Configuration | missing or invalid, on encapsulated data | 0 | No codec reads it: RLE is by segment, and JPEG and JPEG 2000 carry their own layout (PS3.5 §8.2). |
    | Samples per Pixel | missing | the codestream's component count; else 3 for RGB/YBR_*, 1 for MONOCHROME*/PALETTE COLOR; else 1 (GDCM) | `ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix` |
    | Photometric Interpretation | missing | MONOCHROME2 for 1 sample, RGB for 3 | Colour data without the attribute is returned unconverted. |
    | Photometric Interpretation | not a defined term, 1 sample | MONOCHROME2 | `ext-gdcm-MR16BitsAllocated_8BitsStored` ("MONOCHROME") |
    | Bits Allocated | encapsulated, missing or not 1/8/16/32 | 8, 16 or 32 to hold the codestream precision | `ext-gdcm-FUJI-ffff-MONO1-J2K` (0xFFFF, SIZ 16-bit): equals `opj_decompress`. `ext-gdcm-DCMTK_JPEGExt_12Bits` (12, SOF 12-bit): equals `dcmdjpeg`. `ext-gdcm-JPEGLosslessSeNonZero` (12, SOF 12-bit): equals GDCM on a copy with Bits Allocated 16 (dcmtk and pylibjpeg refuse its SOS). |
    | Bits Allocated | native, missing | 8, 16 or 32 when the Pixel Data length is exactly (or with 1 pad byte) Rows × Columns × Samples × Frames × 1, 2 or 4 bytes | consistency check on the length |
    | Bits Stored | missing, 0, or above Bits Allocated | the codestream precision if it fits, else Bits Allocated (no masking) | FUJI file (0xFFFF). Keeping every bit loses nothing. |
    | Pixel Representation | missing | the JPEG 2000 SIZ sign bit; else 0, as GDCM and dcmtk assume | |
    | Rows, Columns | missing or 0, encapsulated | from SOF or SIZ | A present value is never overridden: a disagreement stays the codec's refusal (`ext-gdcm-JPEGNote_bogus`). |
    | Rows or Columns | native, one of them missing | the only value that makes the Pixel Data length fit exactly (or with 1 pad byte) | consistency check on the length |
    | Pixel Data (encapsulated) | after at least one fragment: fewer than 8 stray bytes, a non-item tag where the delimiter belongs, or a last fragment that claims at most 2 bytes more than remain | the fragments read so far | CENSUS.md, tolerance list: "odd-length last fragment, fragment length off by one, garbage terminator". A larger overrun is a truncated file and is still refused. |

    | Bits Allocated | native, 12 | 16, each pair of samples unpacked from three bytes | ACR-NEMA packing (rule 19) |
    | Bits Allocated, Samples per Pixel, Planar Configuration | native, Bits Allocated 24 with no Samples per Pixel | 8, 3, 0 | ACR-NEMA 24-bit RGB (rule 19) |
    | Rows, Columns | native, Recognition Code `ACRNEMA_LIBIDO*` | swapped | rule 19 |
    | Samples per Pixel | missing, ARGB, CMYK or HSV | 4, 4, 3 | the colour model |
    | Planar Configuration | missing, 4-sample data | 0 | |

    **Left as refusals, and why:**
    - **Native Pixel Data shorter than the image.** Missing samples cannot be inferred, and padding them would invent pixels. Examples: `pydicom-MR_truncated`, the Orthanc `oob-monochrome` files.
    - **Excess native data that would hold extra whole frames when Number of Frames is absent.** pydicom returns the extra frames, but no file in the 6,000-file sweep or the corpus does this. Ignoring the excess, as now, is the conservative reading.
    - **Planar Configuration when neither reading is clearly smoother**, or the image is too small to judge.
    - **Rows and Columns both missing on native data.** Many sizes fit any given length.

16. **Float and Double Float Pixel Data.** The canonical form is the stored IEEE 754 values, f32 or f64 little endian (CONTRACT.md, "Float pixel data"). Bits Allocated is 32 or 64 by the element; a missing or different declared value is inferred from it. Samples per Pixel 1 or 3, Planar Configuration as for integer data, Explicit VR Big Endian swapped per sample. Float Pixel Data under an encapsulated transfer syntax is invalid. Oracle: pydicom, and GDCM agrees on all four cases (cornerstone3D `paramap-float` and three IDC Parametric Maps, highdicom 0.27.0).
17. **Encapsulated Uncompressed (.1.98) and Deflated Image Frame Compression (.8.1).** Each frame is one fragment (or the fragments PS3.5 A.4 frame splitting gives) holding the native frame bytes, raw-deflated (RFC 1951, no zlib header) for .8.1, with an optional pad byte. Bits Allocated 1 frames start on a byte boundary. The frames then follow the native rules (4:2:2 expansion, planar, Bits Stored, colour). A frame that does not hold or inflate to its native size is invalid. pydicom 3.0.2 refuses both syntaxes, so the reference `pydicom:unwrapped` unwraps or inflates the frames in Python and has pydicom decode them as Explicit VR Little Endian. The 18 generated cases (`scripts/sources/unwrapped.py`) take their oracle from their native source case (`oracle_case`); the three cornerstone3D files equal their Explicit VR siblings (`CTImage.dcm_Deflated…1.2.1.99`, two families, and the uncompressed `ColorImage.dcm`).
18. **GE private Implicit VR Big Endian (1.2.840.113619.5.2).** The data set (and in `ext-gdcm-GE_DLX-8-MONO2-PrivateSyntax` the meta too) is implicit VR little endian; Pixel Data samples are big endian, so 16-bit samples are swapped and 8-bit ones are not. Oracle: GDCM's own reader (`gdcm-native`), which pydicom cannot reach because it refuses the syntax.
19. **ACR-NEMA forms that GDCM reads.** All are native and are reported as inferences.
    - Bits Allocated 12: two samples in three bytes, `b0 | (b1 & 0x0F) << 8` and `b1 >> 4 | b2 << 4`, unpacked into 16 bits (`ext-fodicom-GH340`).
    - Bits Allocated 24 with no Samples per Pixel: one interleaved 8-bit RGB pixel (`ext-gdcm-LIBIDO-24-ACR_NEMA-Rectangle`).
    - Recognition Code (0008,0010) `ACRNEMA_LIBIDO*`: Rows and Columns are stored swapped (`ext-gdcm-gdcm-ACR-LibIDO.acr`, `ext-gdcm-LIBIDO-24-ACR_NEMA-Rectangle`).
    - No Photometric Interpretation: MONOCHROME2 for one sample (`ext-gdcm-SIEMENS_GBS_III-16-ACR_NEMA_1.acr`; its oracle is a repaired copy, since GDCM aborts on its rescale values).

    pydicom refuses all four; the oracle is `gdcm-native` or the repaired copy.
20. **YBR_PARTIAL_422 and the retired colour models.** No real files are known; 20 cases are generated from RGB seeds (`scripts/sources/retired_photometrics.py`). The standard defines the models but no RGB conversion for HSV and CMYK, and pydicom and GDCM convert none of them, so DCMTK's dcm2img (`dcmtk-color`, the only reader that implements them) is the reference. `retired.rs` has the formulas:
    - HSV: Foley's hexcone algorithm as DCMTK computes it, hue 0..=max covering 0°–360°. Exact against DCMTK.
    - CMYK: R, G, B = max − C/M/Y − K, at least 0. Exact against DCMTK wherever C + K ≤ max (DCMTK wraps around above that).
    - ARGB: where alpha > 0 the Palette Color Lookup Tables indexed by alpha give the colour, scaled to Bits Stored; elsewhere RGB as stored. Exact against DCMTK when the tables are as deep as the samples; DCMTK does not rescale the RGB planes to a deeper table, which is not meaningful.
    - YBR_PARTIAL_422: expanded like YBR_FULL_422, then the exact inverse of the PS3.3 C.7.6.3.1.2 equations, rounded half up, 8-bit only. DCMTK uses 4-digit coefficients and truncates, so it differs by up to 2; ours is closer to the seed RGB (mean |diff| 0.46 against 0.69 on `pydicom-US1_UNCR`). Ruling: max_abs 2.

    Signed data in these models is unsupported (exit 3).
## STATUS

**Coverage round (decoders agent, 2026-10-15). uncompressed: pass=319 / 319.** New: Float and Double Float Pixel Data, Encapsulated Uncompressed, Deflated Image Frame Compression, the GE private syntax, files without a Part 10 meta, the ACR-NEMA forms of rule 19, YBR_PARTIAL_422 and the retired colour models (rules 16–20). 64 cases added. `--frames A-B` decodes a frame range; `scripts/check_frames.py` checks every multi-frame case's range against its whole decode (222 cases, all identical).

**Inference round (foundation agent, 2026-10-15). uncompressed: pass=255 / 255.** It added 12 cases:
- 8 `strip-pc-*`: 7 decode and 1 is refused as too small;
- 2 real IDC files without Planar Configuration;
- 2 repaired copies, which are their oracles.

They were registered from a one-off script through `discover.register`, `save_cases` and `oracle_case`. Across all formats every case passes except 3, which are deliberate improvements needing expectation changes (rule 15): `ext-gdcm-DCMTK_JPEGExt_12Bits` (jpeg-dct), `ext-gdcm-JPEGLosslessSeNonZero` (jpeg-lossless) and `ext-gdcm-FUJI-ffff-MONO1-J2K` (jpeg2000). Each is expect=error today and now decodes to exactly what dcmtk, GDCM or OpenJPEG gives on the file or on a copy with Bits Allocated fixed. Suggested oracles, as `repairs.py` `patch_attr` calls:
- `BitsAllocated=16` for the two JPEG files;
- `BitsAllocated=16, BitsStored=16` for the FUJI file.

No other case changed result. Tests: 30 unit tests, and 36 end-to-end tests including one per inference rule and the refusals. A 300,000-iteration mutation fuzz run found no panics.

**Earlier round: IDC and quirk-set fixes (2026-10-14).** The coordinator has since applied the expectation changes in this table through `repairs.py`:

| Case | Then | Should be |
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
- Bits Allocated other than 1, 8, 16 or 32 (and the ACR-NEMA 12 and 24) is unsupported.
- YBR_PARTIAL_422 is converted for 8-bit samples only, and ARGB, CMYK and HSV for unsigned samples only.
- Nothing is read after the top-level Pixel Data element.
