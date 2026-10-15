# Long-tail sweep of IDC

A check of `shl-dicom-decode` against the reference decoders on 9,557 IDC instances, run on 2026-10-15. The instances were chosen to cover the rare values of metadata that predict encoder and file-structure quirks, plus a uniform random control of 1,000. Each file was downloaded, decoded by our CLI and by the references, compared, recorded and deleted. Files that did not pass were kept and registered as `idc-lt-*` corpus cases.

Earlier IDC sampling ([IDC_SAMPLES.md](IDC_SAMPLES.md)) took one or a few files per pixel profile and per manufacturer/model. This sweep stratifies by the clues in [Clues](#clues) instead, and weights rare values first.

All files are de-identified IDC data under CC BY 3.0 / CC BY 4.0 (per instance in `cases.json` → `source.license`). Downloads and kept copies live on `/media/barracuda/shlink-dicom-sweep/` (external disk; `tmp/` for in-flight files, `keep/` for non-pass files). Registered samples are in the gitignored `formats/*/samples/`. Do not publish them.

## Results

| | Instances | Pass | Rate (95% CI, Wilson) |
|---|---:|---:|---|
| Random control | 1,000 | 1,000 | 100% (99.62%–100%) |
| Long-tail selection (set cover + extra rare candidates) | 8,866 evaluated | 8,851 | 99.83% (99.72%–99.90%) |
| All evaluated | 9,537 | 9,522 | 99.84% (99.74%–99.90%) |

- **Control:** 998 control instances passed in the main sweep. The other 2 were whole-slide images too large to decode whole, and both passed the [frame-wise check](#oversize-instances-frame-wise). No control instance failed, crashed or was refused.
- **Long tail:** 15 instances did not pass. There were no crashes and no timeouts. The 15 fall into 4 root causes; see [Failure groups](#failure-groups).
- **Not evaluated:**
  - 3 instances have Bits Allocated in IDC but no Pixel Data element; our CLI and the references all refuse them.
  - 17 decode to more than 2 GB and were checked [frame-wise](#oversize-instances-frame-wise) instead; all pass.
  - 4 instances over 500 MB were not downloaded; see [Selection](#selection).
- **Builds:**
  - The main sweep used `shl-dicom-decode` built at the start (CARGO_TARGET_DIR `codecs/target/longtail`).
  - Every non-pass was re-checked with a fresh build of the current tree at the end. That build includes the coordinator's planar-configuration inference. The table above uses the re-checked outcomes.
  - In the first build, the 8 missing-Planar-Configuration files were `all-fail`, because we refused them like the references. In the fresh build we decode them, and that output is correct; see [Failure groups](#failure-groups).

## Clues

The table `bigquery-public-data.idc_current.dicom_all` has 958 columns. These are the clues used. Each is computed per instance in `sql/longtail_candidates.sql`, and the frequencies are in `cache/longtail/selection.json` (`freq`).

| Clue | Columns | Why it predicts quirks | Distinct values in IDC |
|---|---|---|---:|
| `ts` | TransferSyntaxUID | Selects the codec and framing path | 10 |
| `impl_ver`, `impl_class` | ImplementationVersionName, ImplementationClassUID (file meta) | The toolkit that wrote the file. For uncompressed data it is the main quirk signal: element encoding, padding, VR choices | 17, 12 |
| `src_ae` | SourceApplicationEntityTitle | The node that sent or wrote the file; separates pipelines | 4 |
| `manufacturer`, `model` | Manufacturer, ManufacturerModelName | The device or converter; for compressed data it is often the encoder | 118, 425 |
| `software` | SoftwareVersions (joined) | Encoder versions change bugs | 1,043 |
| `combo` | TS × ImplementationVersionName × Manufacturer × Model × SoftwareVersions | Rare encoder pipelines | 2,900 |
| `sop_class` | SOPClassUID | Enhanced and multi-frame objects, SEG, WSI, Parametric Map, US, MG/tomo | 25 |
| `modality` | Modality | As SOP class, coarser | 17 |
| `conversion_type` | ConversionType | Secondary capture origin (WSD, DRW, SI, DI …) | 8 |
| `image_type` | ImageType (joined) | DERIVED / SECONDARY / LOCALIZER / vendor values | 731 |
| `photometric` | PhotometricInterpretation | Colour path | 8 |
| `bits` | BitsAllocated / BitsStored / HighBit / PixelRepresentation | Masking and sign extension | 14 |
| `high_bit` | HighBit − (BitsStored − 1) | A non-standard High Bit position | 2 (only "normal" and absent occur) |
| `spp_planar` | SamplesPerPixel / PlanarConfiguration (absent kept distinct) | Planar handling; a missing Planar Configuration | 6 |
| `frames` | NumberOfFrames bucket (absent, 1, 2–10, 11–100, 101–1000, >1000) | Framing | 6 |
| `lossy`, `lossy_method`, `lossy_ratio` | LossyImageCompression, its Method and first Ratio (bucketed) | Compression history; transcoded files | 3, 3, 6 |
| `padding` | PixelPaddingValue (absent / 0 / negative / ≥ 32768 / positive) and PixelPaddingRangeLimit | US/SS VR ambiguity and value range | 6 |
| `smallest_value` | SmallestImagePixelValue (absent / negative / ≥ 32768 / non-negative) | A US/SS VR that depends on Pixel Representation | 4 |
| `rescale_type` | RescaleType | Unusual writers ("je ne sais pas", "OD") | 25 |
| `voi_lut` | VOILUTSequence present | Sequences before Pixel Data | 2 |
| `palette` | Red Palette Color LUT Descriptor values, + LargePaletteColorLookupTableUID | Palette tables of odd size and depth | 236 |
| `icon` | IconImageSequence present | Nested pixel data before the main Pixel Data | 2 |
| `overlay` | OverlayRows present | Overlay groups (60xx) | 2 |
| `presentation_lut` | PresentationLUTShape | INVERSE with MONOCHROME2 and similar | 3 |
| `odd_dims` | Rows or Columns odd; Bits Allocated 1 with Rows × Columns not a multiple of 8 | Padding and bit-packing edge cases | 8 |
| `size_shape` | instance_size vs Rows × Columns × frames × samples × bytes: for uncompressed the overhead bucket (short, < 1 KB … ≥ 1 MB, > 2×); for compressed the ratio bucket | Truncated files, large headers, odd encapsulation | 14 |
| `collection` | collection_id | Contributor pipeline | 179 |
| `year5` | StudyDate, 5-year bucket | Age of the device (dates are shifted by de-identification) | 22 |
| `profile` | the pixel profile of [SOURCES.md](SOURCES.md) | Ties to the coverage estimate | 89 |

Three requested clues are not in the table:
- **Extended Offset Table** (7FE0,0001). The sweep reads it from each downloaded file instead; see [File structure](#file-structure-in-the-files-swept).
- **VOI LUT and Palette data.** Only the sequence and descriptor columns exist, so their presence is used.
- **DeidentificationMethod.** It exists but costs 3.06 GB to scan and says little about pixel encoding, so it was left out.

**IDC writes few distinct toolkits.** Only 17 ImplementationVersionName values occur in all of IDC:
- `0.5`, used by about 5,240 of the swept instances;
- dcm4che 1.4.27–1.4.38;
- PixelMed;
- DCMTK 3.6.2–3.7.0;
- highdicom 0.22–0.27;
- pydicom 3.0.1;
- DCTOOL100.

Most of IDC was rewritten by a few pipelines after acquisition, so the writing toolkit is much less varied than the acquiring device.

## Selection

`scripts/sources/longtail_select.py`, from the candidate pool of `sql/longtail_candidates.sql`:

1. **Candidate pool.** One scan (20.69 GB) returns:
   - the frequency of every (clue, value) pair;
   - 3 pseudo-random instances per pair, and 2 per `combo`, ordered by FARM_FINGERPRINT and preferring ≤ 100 MB;
   - the uniform control: instances with `MOD(ABS(FARM_FINGERPRINT(instance_uuid)), 40000) = 17`, of which the first 1,000 by hash are used.

   That gives 10,077 instances.
2. **Greedy set cover.** An instance's gain is the sum of n^−0.5 over the (clue, value) and combo pairs it would newly cover, where n is the IDC instance count of the pair, divided by (1 + size / 100 MB). 3,421 instances cover all 5,945 pairs that the pool can reach (of 5,950).
   - The other 5 pairs occur only on instances over 500 MB: 4 PixelMed slide combos and one SoftwareVersions value, "Sat May 28 11:42:06 EDT 2022".
3. **Extra.** The remaining pool candidates of pairs with n ≤ 100,000, rarest first: 5,465 instances. These are the second and third examples of rare values.
4. **Control.** 1,000 instances. 329 of them were also picked by the cover or extra steps.
5. **Size limit.** Instances over 500 MB were dropped and not downloaded:
   - `tcga_lusc` JPEG 2000 YBR_ICT slides of 594 and 650 MB;
   - `tcga_kirp` slides of 1,095 MB (JPEG Baseline RGB) and 3,683 MB (JPEG 2000 YBR_ICT).

   None was in the control.

The selection, with every instance's clues and the pairs it was picked to cover, is `cache/longtail/selection.json` (9,557 instances, 38.4 GB).

**What was swept:**
- 179 collections, 118 manufacturers, 425 models and 1,042 SoftwareVersions values;
- 10 transfer syntaxes:

  | Syntax | Instances |
  |---|---:|
  | Explicit VR LE | 7,458 |
  | Implicit VR LE | 1,616 |
  | JPEG Baseline | 178 |
  | JPEG 2000 Lossless | 111 |
  | JPEG 2000 | 74 |
  | JPEG Lossless SV1 | 64 |
  | Explicit VR BE | 38 |
  | JPEG Extended | 12 |
  | Deflate | 3 |
  | JPEG-LS | 3 |

## Sweep method

`scripts/sources/longtail_sweep.py` ran with 8 workers, under a disk budget of 40 GB for files in flight and a memory budget of 16 GB, estimated at 6 × the decoded size. Progress is kept in `cache/longtail/results.jsonl`, so the sweep can resume. Per instance:

1. **Download** over HTTPS from the public IDC bucket (`https://<bucket>.s3.amazonaws.com/<series_uuid>/<instance_uuid>.dcm`) into `/media/barracuda/shlink-dicom-sweep/tmp/`.
2. **Probe** the file structure in a subprocess:
   - which pixel data element it has;
   - Extended Offset Table presence;
   - Basic Offset Table entries;
   - fragment count and odd-length fragments;
   - native Pixel Data length against the expected length;
   - elements after Pixel Data.
3. **Decode with ours:** `shl-dicom-decode IN OUT`, with a timeout of 60 s + 120 s per decoded GB.
4. **Decode with every reference** that `ref_decode.applicable` lists for the syntax, one subprocess each, with a timeout of 180 s + 300 s per decoded GB.
5. **Compare** as `oracle.py` does. The first reference that decodes is the oracle. Lossless syntaxes must match exactly; lossy ones must be within max(1, the largest disagreement between references). The comparison is chunked over memory-mapped files.
6. **Record and clean up:** write the outcome, timings and clues; delete the files; copy any non-pass file to `keep/`.

| Outcome | Meaning |
|---|---|
| `pass` | Within tolerance of the oracle |
| `mismatch` | Decoded, outside tolerance |
| `ref-dispute` | A lossless mismatch where ours equals another reference |
| `our-crash` | A signal, exit 101 or a timeout |
| `our-refusal-but-refs-decode`, `our-unsupported-but-refs-decode` | We exit 2 or 3, and a reference decodes |
| `refs-fail-we-decode` | No reference decodes, and we do |
| `all-fail` | Nobody decodes |

## Results by stratum

These tables use the final outcomes: the main sweep, with the 19 non-pass instances re-checked on the fresh build. Strata with a non-pass come first. Full tables are in `cache/longtail/report_final.md` (`scripts/sources/longtail_report.py`).

### By transfer syntax

| Transfer syntax | Swept | Evaluated | Pass | Not pass |
|---|---:|---:|---:|---|
| Explicit VR LE | 7,458 | 7,455 | 7,444 | 8 refs-fail-we-decode (missing Planar Configuration), 3 unsupported (Float Pixel Data) |
| JPEG 2000 | 74 | 69 | 65 | 4 mismatch (Leica YBR_FULL_422, max \|diff\| 3) |
| Implicit VR LE | 1,616 | 1,616 | 1,616 | |
| JPEG Baseline | 178 | 172 | 172 | |
| JPEG 2000 Lossless | 111 | 105 | 105 | |
| JPEG Lossless SV1 | 64 | 64 | 64 | |
| Explicit VR BE | 38 | 38 | 38 | |
| JPEG Extended | 12 | 12 | 12 | |
| Deflate | 3 | 3 | 3 | |
| JPEG-LS Lossless | 3 | 3 | 3 | |

### By writing toolkit (ImplementationVersionName / ImplementationClassUID)

| Toolkit | Swept | Evaluated | Pass | Not pass |
|---|---:|---:|---:|---|
| 0.5 / 1.3.6.1.4.1.22213.1.143 | 5,240 | 5,240 | 5,232 | 8 refs-fail-we-decode |
| PIXELMEDJAVA001 / 1.3.6.1.4.1.5962.99.2 | 539 | 522 | 518 | 4 mismatch |
| highdicom0.27.0 / 1.2.826.0.1.3680043.9.7433.1.1 | 19 | 19 | 16 | 3 unsupported |
| dcm4che-1.4.35 / 1.2.40.0.13.1.1.1 | 1,528 | 1,528 | 1,528 | |
| dcm4che-1.4.34 / 1.2.40.0.13.1.1.1 | 1,024 | 1,024 | 1,024 | |
| dcm4che-1.4.31 / 1.2.40.0.13.1.1.1 | 826 | 824 | 824 | |
| dcm4che-1.4.27 / 1.2.40.0.13.1.1 | 227 | 226 | 226 | |
| dcm4che-1.4.38 / 1.2.40.0.13.1.1.1 | 89 | 89 | 89 | |
| DCTOOL100 / 1.3.6.1.4.1.5962.2 | 15 | 15 | 15 | |
| PYDICOM 3.0.1 / 1.2.826.0.1.3680043.8.498.1 | 12 | 12 | 12 | |
| OFFIS_DCMTK_366, 368, 369, 370, 362 | 30 | 30 | 30 | |
| highdicom0.22.0, 0.23.0 | 8 | 8 | 8 | |

### By manufacturer

| Manufacturer | Swept | Evaluated | Pass | Not pass |
|---|---:|---:|---:|---|
| GE Healthcare | 108 | 108 | 102 | 6 refs-fail-we-decode |
| Leica Biosystems | 490 | 473 | 469 | 4 mismatch |
| Gevaert Lab Converted By Imaging Data Commons | 3 | 3 | 0 | 3 unsupported |
| Philips | 613 | 613 | 611 | 2 refs-fail-we-decode |
| GE MEDICAL SYSTEMS | 2,743 | 2,741 | 2,741 | |
| SIEMENS | 2,668 | 2,668 | 2,668 | |
| Philips Medical Systems | 645 | 645 | 645 | |
| TOSHIBA | 527 | 526 | 526 | |
| (absent) | 285 | 285 | 285 | |
| HOLOGIC, Inc. | 143 | 143 | 143 | |
| 108 other manufacturers | 1,307 | 1,307 | 1,307 | |

### By SOP class

| SOP class | Swept | Evaluated | Pass | Not pass |
|---|---:|---:|---:|---|
| VL Whole Slide Microscopy | 551 | 534 | 530 | 4 mismatch |
| Secondary Capture | 220 | 220 | 216 | 4 refs-fail-we-decode |
| Ultrasound | 133 | 133 | 129 | 4 refs-fail-we-decode |
| Parametric Map | 3 | 3 | 0 | 3 unsupported |
| CT | 4,285 | 4,282 | 4,282 | |
| MR | 2,850 | 2,850 | 2,850 | |
| PET | 549 | 549 | 549 | |
| Segmentation | 183 | 183 | 183 | |
| Raw Data (1.2.840.10008.5.1.4.1.1.66) | 148 | 148 | 148 | |
| CR | 125 | 125 | 125 | |
| DX, MG, Breast Tomosynthesis | 350 | 350 | 350 | |
| US Multi-frame | 61 | 61 | 61 | |
| NM, XA, RF, RT Dose, RT Image, MF SC and other | 99 | 99 | 99 | |

## Failure groups

Each group is listed with the component at fault, the right behaviour and the evidence. Case ids are the registered `idc-lt-*` cases. 15 non-pass instances form 4 groups. Nothing crashed, and no file was decodable only by us without independent support.

### 1. Missing Planar Configuration in RGB secondary captures and ultrasound

- **Instances:** 8.
  - GE Healthcare LOGIQ E9 ultrasound (`cmb_mel`), 4;
  - GE Healthcare secondary captures (`cptac_pda`), 2;
  - Philips IntelliSpace Portal 4.1 CT secondary captures (`cptac_luad`), 2.

  All are written by toolkit `0.5`, Explicit VR LE, RGB 8-bit, single frame.
- **Problem:** (0028,0006) is absent, but PS3.3 C.7.6.3 makes it Type 1C, required when Samples per Pixel > 1.
- **References:** pydicom refuses, which means both `pydicom:pydicom` and `pydicom:gdcm`. Native GDCM (`gdcm.ImageReader`) assumes 0. `dcm2pnm` refuses ("mandatory attribute 'PlanarConfiguration' is missing").
- **Evidence for the layout:**
  - In the GE files, the interleaved reading is smooth. The mean horizontal neighbour difference is 2.3–3.0 interleaved against 5.2–12.2 planar.
  - In the Philips files, the planar reading is smooth (2.3 and 2.7 against 4.7 and 4.8).
  - Rendered both ways, the Philips image is a clean 3 × 3 CT montage when read as planar, and tiles 3 × 3 with colour fringes when read as interleaved.

  So GDCM's default of 0 is wrong for the Philips files, and no fixed default is right.
- **Our behaviour:** the first build refused all 8 (exit 2), as pydicom does. The fresh build infers the layout from smoothness ("note: inferred PlanarConfiguration = 1: missing; the planar reading is clearly smoother"). Its output equals the planar reading for Philips and the interleaved reading for GE, byte for byte.
- **Component:** CLI (`shl-dicom-decode` inference, coordinator-owned). It is now correct.
- **Cases:**
  - originals: `idc-lt-model-intellispace-p-310c4091` and `idc-lt-imgtype-derived-second-de33dc5b` (Philips, planar); `idc-lt-sw-logiqe9-r6-2-0-44d156ec` (LOGIQ E9 US) and `idc-lt-sw-logiqe9-r4-3-0-ab87d1f0` (`cptac_pda` SC), interleaved;
  - repaired copies with Planar Configuration added: `idc-lt-repair-planar1-de33dc5b`, `idc-lt-repair-planar0-44d156ec`, `idc-lt-repair-planar0-ab87d1f0`.

  The coordinator had already registered `idc-lt-planar-3-absent-4eca9830` and `repair-idc-lt-*` copies for two of these. I removed my duplicate repair of `310c4091`. I also set `oracle_case` and the coordinator's ruling text on my three remaining originals, which applies the coordinator's ruling to new files of the same class; please confirm. All 10 uncompressed `idc-lt-*` cases pass.

### 2. JPEG 2000 YBR_FULL_422 with subsampled chroma (Leica Aperio, PixelMed TIFFToDicom)

- **Instances:** 5 in the main sweep (`tcga_kich`, `tcga_kirc`, `tcga_ucec`, `tcga_hnsc`, `cptac_ov`).
- **Cause of the mismatches:** this is the known reference issue in [jpeg2000 FORMAT.md, Subsampled chroma](../formats/jpeg2000/FORMAT.md#subsampled-chroma-leica-aperio-slides-ybr_full_422). OpenJPEG already converts sYCC to RGB, and pydicom converts a second time, so pylibjpeg differs from openjpeg-cli by up to 252. The main sweep's mismatches came from that.
- **Re-check:** the files were decided with `pydicom:pylibjpeg-raw` and `openjpeg-cli`, which agree exactly with each other, at that format's ruling of max_abs 2.
  - 1 file is within 2 (`17613ded`).
  - **4 files reach 3.** Measured over every frame of each file:
    - `5a326fa5`: 0.109% of samples differ, and 3 of 103 million samples differ by 3;
    - `86686ebf`: 0.049% differ;
    - `574ef2f0`: 0.041% differ;
    - `b7b40d74`: 0.064% differ.

    The 29-frame frame-wise samples of these files all stay within 2.
- **Diagnosis:**
  - In `5a326fa5`, differences of 1 are spread evenly over R, G and B and over all frames. They show no parity, edge or tile pattern.
  - The 3s are in R and B only.
  - This is what ±1 differences in the decoded Y/Cb/Cr components look like after OpenJPEG's truncating conversion, r = y + (int)(1.402·cr) and b = y + (int)(1.772·cb). ±1 is normal between two independent 9/7 inverse-wavelet implementations.
- **Component:** jpeg2000 codec, within lossy tolerance. It is not a decoding error.
- **Right behaviour:** keep the decode; raise the ruling's max_abs for this class from 2 to 3.
- **Case:** `idc-lt-combo-63dd4058` (11 MB, 525 frames). I set `oracle_ref` and `max_abs_override` from the existing ruling, so it fails today at 3 > 2. A second case, `idc-lt-combo-16cce668` (21 MB), was registered and then removed: its oracle build was killed for memory, because `openjpeg-cli` in `ref_decode.py` stacks all frames as int64, about 8 GB for this file.

### 3. Float Pixel Data (Parametric Map)

- **Instances:** 3 `tcga_gbm` instances, "Gevaert Lab Converted By Imaging Data Commons", highdicom 0.27.0, with (7FE0,0008) Float Pixel Data.
- **Behaviour in the sweep:** exit 3, "float pixel data not supported". pydicom decodes them.
- **Now:** decoded to f32 ([CONTRACT.md, Float pixel data](../CONTRACT.md#float-pixel-data)), equal to pydicom and GDCM.
- **Cases:** `idc-lt-sop-1-2-840-10008-{9c519f08,a1cc97dd,eb217aa0}`, all three files.

### 4. Empty frames at the end of a whole-slide image

Found by the frame-wise check, not by the main sweep. See [Oversize instances, frame-wise](#oversize-instances-frame-wise).
- **File:** `2553b307` (collection `nlst`, Aperio converted by PixelMed TIFFToDicom, JPEG Baseline RGB, TILED_FULL, 32,625 frames of 240 × 240).
- **Problem:** the last 225 frames are zero-length items. The total pixel matrix is 53,829 × 34,563, so the last tile row covers only 3 pixel rows, and the converter wrote that row as 225 empty frames.
- **Behaviour today:** our whole-file decode refuses (exit 2, "codestream does not start with SOI"). pydicom with pylibjpeg or GDCM fails on frame 32400 too. All 32,400 real frames decode and match the references.
- **Component:** CLI framing and decode policy (coordinator).
- **Right behaviour:** needs a ruling. Refusal matches the references and the standard, since a frame must hold a codestream. A viewer would rather draw the empty tiles as background and keep the rest. The frame-range path (`decode_frames`) already lets a viewer decode around them.
- **Case:** none; the file is 205 MB. A small derived case (two real frames plus one empty item) would capture it; see [Requests](#requests-for-the-coordinator).

## Oversize instances, frame-wise

17 instances decode to more than 2 GB (2.4–11.8 GB; up to 70,035 frames), too much for the sweep's in-memory references. 2 of them are in the control. `scripts/sources/longtail_framewise.py` checks each one with bounded memory:

- **Hash pass.** pydicom splits the frames. Each group of 16 frames is written into a temporary Part 10 file: the original header, Number of Frames 16, no Extended Offset Table, one fragment per frame and a Basic Offset Table. That file is decoded with our CLI, and a SHA-256 is recorded for every frame. Only one chunk is decoded at a time.
- **Sample.** About 30 frames: the first, the last, evenly spread frames, and 5 seeded-random ones.
  - Each is decoded again alone through our CLI. Its hash must equal the hash from the chunked decode, as a determinism check.
  - Each is decoded with the references: `pixel_array(original, index=i)` through pylibjpeg and GDCM, which uses pydicom's own framing. For JPEG 2000, `pydicom:pylibjpeg-raw` and `openjpeg-cli` on a one-frame file are added. For YBR_FULL_422 the oracle is `pylibjpeg-raw` with the jpeg2000 ruling of max_abs 2.
- **Own framing.** `scripts/sources/longtail_ownframing.py` runs `longtail_frames hashall` over the original file. This binary wraps `shl-dicom-decode-wasm::decode_frames`, which uses the CLI's own `parse.rs` and `encaps.rs` framing, and decodes 16 frames per call. The resulting per-frame hashes are compared with the pydicom-framed hash pass.
- **Peak memory** is the largest VmHWM read from `/proc` while each subprocess runs, polled every 20 ms. Very short decodes can finish between polls, so the small figures are lower bounds.

The 3 large Leica mismatches from the main sweep (`86686ebf`, `574ef2f0`, `b7b40d74`) were also checked this way.

| Instance | Syntax, photometric | Frames | Sampled frames OK | Max \|diff\| | Determinism | Own framing = pydicom framing | Peak RSS, ours chunk / own framing / largest reference (MB) | Size (MB) |
|---|---|---:|---:|---:|---|---|---|---:|
| b56dfdef | J2K, YBR_ICT | 20,264 | 29/29 | 1 | same | yes | 7.6 / 96 / 157 | 91 |
| b0fbc532 (control) | JPEG Baseline, RGB | 21,158 | 29/29 | 1 | same | yes | 8.2 / 209 / 69 | 209 |
| 4fda9967 (control) | JPEG Baseline, RGB | 12,245 | 29/29 | 1 | same | yes | 7.2 / 271 / 68 | 276 |
| c9ff4c03 | J2K Lossless, MONOCHROME2 | 2,415 | 29/29 | 0 | same | yes | 44 / 495 / 543 | 471 |
| a1e4eeb4 | J2K Lossless, MONOCHROME2 | 2,415 | 29/29 | 0 | same | yes | 44 / 496 / 543 | 472 |
| d6cbe379 | J2K Lossless, MONOCHROME2 | 2,415 | 29/29 | 0 | same | yes | 45 / 517 / 562 | 491 |
| fc620d71 | J2K Lossless, MONOCHROME2 | 2,278 | 29/29 | 0 | same | yes | 46 / 523 / 568 | 497 |
| 191b41ff | J2K Lossless, MONOCHROME2 | 2,278 | 29/29 | 0 | same | yes | 45 / 499 / 546 | 474 |
| 1971b101 | J2K Lossless, MONOCHROME2 | 2,278 | 29/29 | 0 | same | yes | 45 / 505 / 545 | 474 |
| 157144ad | J2K, YBR_ICT | 42,940 | 29/29 | 1 | same | yes | 8.3 / 416 / 477 | 425 |
| 422ddffd | J2K, YBR_ICT | 59,840 | 29/29 | 1 | same | yes | 8.3 / 427 / 487 | 435 |
| d18e9f89 | J2K, YBR_FULL_422 | 70,035 | 29/29 | 2 | same | yes | 8.1 / 81 / 141 | 72 |
| ea71897b | J2K, YBR_FULL_422 | 23,312 | 29/29 | 2 | same | yes | 8.2 / 52 / 113 | 44 |
| 822c287c | JPEG Baseline, RGB | 13,832 | 29/29 | 1 | same | yes | 3.8 / 59 / 68 | 54 |
| bba804f3 | JPEG Baseline, RGB | 17,325 | 29/29 | 1 | same | yes | 3.6 / 95 / 68 | 91 |
| e5168b14 | JPEG Baseline, RGB | 11,970 | 29/29 | 1 | same | yes | 6.8 / 103 / 68 | 99 |
| 2553b307 | JPEG Baseline, RGB | 32,625 (225 empty) | 28/28 | 1 | same | yes, for the 32,400 real frames; refuses frame 32400 | 0.9 / 204 / 68 | 205 |
| 86686ebf | J2K, YBR_FULL_422 | 5,031 | 29/29 | 2 | same | yes | 8.3 / 30 / 88 | 21 |
| 574ef2f0 | J2K, YBR_FULL_422 | 5,500 | 28/28 | 2 | same | yes | 8.5 / 39 / 98 | 31 |
| b7b40d74 | J2K, YBR_FULL_422 | 9,020 | 29/29 | 2 | same | yes | 8.4 / 79 / 141 | 73 |

- **Result.** All 17 oversize instances pass frame-wise, and so do the 3 large Leica files under the jpeg2000 ruling.
- **Totals over the 20 files:**
  - 358,951 non-empty frames were hashed through our CLI, plus 225 empty ones;
  - 578 sampled frames were compared with the references;
  - no frame decoded differently alone than in a chunk;
  - our own framing gave the same per-frame hashes as pydicom's on every file.
- **Memory.** Our decoder's own-framing peak is about the compressed file size plus a few MB. `decode_frames` reads the whole file into memory but keeps only the requested frames' pixels.
- **Not exercised here:** our whole-file decode of these instances. It would allocate 2.4–11.8 GB of output.

## File structure in the files swept

From the probe of 9,520 files with Pixel Data:

- **Encapsulated (421 files).**
  - Every one has exactly one fragment per frame; none has frames split over fragments.
  - 336 have an empty Basic Offset Table and 85 a full one.
  - 14 have an Extended Offset Table: 12 Mirax slides written by pydicom 3.0.1 and 2 PixelMed Leica slides. All 14 pass.
  - No odd-length fragments, and no data after the sequence delimiter.
- **Native (9,099 files).** 9,076 have exactly the expected Pixel Data length and 23 have 1 extra pad byte. None is short.
- **Other structure.**
  - 613 files have elements after Pixel Data. Most are PixelMed (`PIXELMEDJAVA001`) and `0.5` files.
  - 14 files carry an Icon Image Sequence.
  - 14 files have a private element (01F1,1026) whose value is text (b"0.829 ") where pydicom's dictionary says FD. pydicom's probe fails on them with "BytesLengthException", but every decoder reads the pixels, and all 14 pass (byte-exact against the reference).

**Decode time.** Our decoder's median time is 5 ms. The slowest were 160–210 MB JPEG 2000 Lossless slides (MONOCHROME2, about 0.6–0.7 GB decoded) at 67–70 s, while the machine's load average was about 29 from other agents. The slowest reference on the same files took 104–144 s. Per frame our JPEG 2000 decode is on par with `opj_decompress` (about 60–90 ms per 1024² frame); the time was the frame count. The CLI now decodes large multi-frame images on up to 8 threads: `e64f56d0` (630 frames) went from 37 s to 11.5 s at load 9, with identical output.

## Requests for the coordinator

1. **jpeg2000 ruling for Leica YBR_FULL_422:** raise max_abs from 2 to 3 (evidence in [group 2](#2-jpeg-2000-ybr_full_422-with-subsampled-chroma-leica-aperio-pixelmed-tifftodicom)). Then `idc-lt-combo-63dd4058` passes.
2. **Rulings applied to new cases (please confirm):**
   - `oracle_case` and ruling text on `idc-lt-imgtype-derived-second-de33dc5b`, `idc-lt-sw-logiqe9-r6-2-0-44d156ec` and `idc-lt-sw-logiqe9-r4-3-0-ab87d1f0`, pointing at their `idc-lt-repair-planar*` copies;
   - `oracle_ref` and `max_abs_override` on `idc-lt-combo-63dd4058`.
3. **Empty frames in TILED_FULL slides:** decide whether a zero-length frame item is exit 2 (today) or an empty tile. A test case can be derived from `2553b307` (frames 32399 and 32400).
4. Done: `ref_decode.py`'s `openjpeg-cli` decodes frame by frame into the output dtype.
5. Done: `shl-dicom-decode --frames A-B`, and `scripts/check_frames.py --file BIG.dcm --frames N` checks a large file in chunks.
6. Done: `discover.register` takes Float Pixel Data; the three files are registered.

## Cost

| Item | Amount |
|---|---|
| BigQuery queries | 3 billed: `longtail_candidates` 20.69 GB, `longtail_licenses` 1.41 GB, `longtail_instance_licenses` 2.89 GB; **total 24.99 GB**. Dry runs, the schema read and per-column pricing were free. |
| Files downloaded | 9,537 in the main sweep (33.5 GB); 17 oversize instances for the frame-wise check (5.0 GB) and again for the own-framing check (about 4.9 GB); 1 extra copy of `2553b307` for diagnosis (0.2 GB). **About 43.6 GB in total.** |
| Wall time | Main sweep 99 min (8 workers; 12.4 h summed per-instance time); re-check of the 19 non-pass instances 6 min; frame-wise check 54 min of instance time (two processes in parallel); own-framing check 22 min |
| Disk | At most about 4 GB in `tmp/` at once; `keep/` holds 153 MB |

## Reproduce

```sh
cd codec-corpus
uv run python scripts/sources/longtail_bq.py prevalence/sql/longtail_candidates.sql prevalence/cache/longtail/candidates.json --dry-run
uv run python scripts/sources/longtail_bq.py prevalence/sql/longtail_candidates.sql prevalence/cache/longtail/candidates.json --max-gb 21
uv run python scripts/sources/longtail_select.py
(cd ../codecs && CARGO_TARGET_DIR=target/longtail cargo build --release -p shl-dicom-decode)
uv run python scripts/sources/longtail_sweep.py --jobs 8                 # resumable
uv run python scripts/sources/longtail_framewise.py                     # skipped-decoded-size instances
(cd scripts/sources/longtail_frames && CARGO_TARGET_DIR=../../../../codecs/target/longtail cargo build --release)
uv run python scripts/sources/longtail_ownframing.py
# re-check the non-pass instances against a fresh build
uv run python scripts/sources/longtail_sweep.py --uuids prevalence/cache/longtail/nonpass.txt --from-keep \
    --ybr422-j2k-raw --results prevalence/cache/longtail/recheck_final.jsonl
cat prevalence/cache/longtail/results.jsonl prevalence/cache/longtail/recheck_final.jsonl > prevalence/cache/longtail/merged.jsonl
uv run python scripts/sources/longtail_register.py --results prevalence/cache/longtail/merged.jsonl --per-group 2
uv run python scripts/sources/longtail_repairs.py
uv run python scripts/oracle.py --format uncompressed --case idc-lt- && uv run python scripts/oracle.py --format jpeg2000 --case idc-lt-
uv run python scripts/sources/longtail_report.py --results prevalence/cache/longtail/merged.jsonl
```

IDC is updated in place (`idc_current`), so a later run may pick different instances. The instances swept this time are in `cache/longtail/selection.json`, and the per-instance outcomes are in `results.jsonl`, `recheck_final.jsonl`, `framewise*.jsonl` and `ownframing.jsonl`.
