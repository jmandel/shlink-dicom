# Coverage plan: everything a study can contain

Status: approved direction (Josh, 15 Oct 2026). It replaces the tier 2 and tier 3 lists in [the census](../codec-corpus/prevalence/CENSUS.md#tier-2-should-support) as the work plan. The census tiers remain only as background on prevalence.

**Goal:** a recipient can see, play or read everything in a shared study, and download all of it. The only exceptions are formats with no public specification or no pixels. Everything we can't show is listed by name, with a download; nothing is dropped silently.

## A. Pixel encodings

| Item | Approach | Reference for checks |
|---|---|---|
| Float and Double Float Pixel Data | Decode to f32/f64. Define a float canonical output in CONTRACT.md. The viewer picks a default window from the data range or from the Real World Value Mapping | pydicom |
| Encapsulated Uncompressed (.1.98), Deflated Image Frame (.8.1) | Unwrap or inflate each frame, then the native path | pydicom; byte-exact |
| GE private implicit VR big endian (1.2.840.113619.5.2) | Parse as implicit big endian | GDCM |
| Files without Part 10 meta | Guess implicit LE, as pydicom's `force=True` does. Extend `register` and `ref_decode` to accept them | pydicom, DCMTK |
| JPEG progressive and spectral selection (.53, .55) | Extend the JPEG decoder: progressive Huffman, coefficient buffer | libjpeg (Richter, via pylibjpeg-libjpeg), libjpeg-turbo |
| JPEG arithmetic coding (.52, .54, .56, .58) | Arithmetic entropy decoder (ISO 10918-1 Annex D) for DCT and lossless | libjpeg (Richter), libjpeg-turbo for DCT |
| JPEG hierarchical (.59–.66) | Frame and differential-frame decoding on top of the above | libjpeg (Richter) |
| JPEG XL (.110–.112) | `shl-jpegxl`, the project's own decoder, behind the codec interface | libjxl (imagecodecs) |
| JPEG 2000 Part 2 multi-component (.92, .93) | Part 2 multi-component transforms in `shl-jpeg2000` | OpenJPEG or Kakadu, wherever one decodes the file |
| Retired photometrics (ARGB, CMYK, HSV, YBR_PARTIAL_422/420) | Colour conversions to RGB | pydicom, GDCM |

**Gate:** each item adds corpus cases with an oracle, and the corpus stays at 100%. There are no new crashes in a 10-minute fuzz run per new entropy decoder.

## B. Every object type in a study

| Object | Shown as |
|---|---|
| Structured Report (incl. radiation dose SR, measurement reports) | A readable document tree, with references linked to the images they cite |
| Encapsulated PDF, CDA | Inline viewer, plus download |
| Segmentation (SEG), RT Structure Set, Parametric Map | Overlays on the referenced images, toggleable, with legend |
| Presentation states (GSPS, colour, blending) | Applied on request; listed as views of the series |
| Key Object Selection | "Key images" list that jumps to the frames |
| Waveforms (ECG, haemodynamic, audio) | Plotted traces with the standard calibrations; audio played |
| Encapsulated STL, OBJ, MTL | 3D view |
| Anything else | A named entry with its size and a download |

**Gate:** a rendering check per object type, using real IDC or public samples where they exist and synthetic ones otherwise. The study overview lists every instance in the Bundle.

## C. Display fidelity

- **Grayscale pipeline:** Modality LUT (rescale and LUT Sequence), VOI LUT Sequence and functions (LINEAR_EXACT, SIGMOID), Presentation LUT Shape, and window presets from the headers.
- **Overlays:** 60xx overlay planes, separate or in unused high bits of the pixel data.
- **Colour:** ICC profiles, for slides and visible-light photos.
- **Geometry:** enhanced multi-frame per-frame functional groups (position, orientation, spacing), with multiplanar reformatting when a series is a volume. Cine timing comes from Frame Time or Frame Time Vector.
- **Measurements:** length, angle and area, calibrated from Pixel Spacing or Imager Pixel Spacing. The calibration source is shown.

**Gate:** rendered output is compared with DCMTK `dcm2pnm` or with a reference rendering, on cases that exercise each feature.

## D. Whole-slide images

- **Layers:** all focal planes, with a focus control. All optical paths, with fluorescence channels composited and per-channel colour and intensity.
- **Layouts:** TILED_SPARSE, tested on a slide we build ourselves if IDC has none.
- **Overlays:** Microscopy Bulk Simple Annotations and slide segmentations drawn on the slide.
- **Encodings:** JPEG XL slides, through A.

**Gate:** wsi-checks extended per feature; bytes-to-first-screen stays within its current range.

## E. Video and cine

- **H.264 and HEVC (.102–.108):** extract the stream and play it in `<video>`. MP4 payloads are joined as is; MPEG-TS payloads are remuxed to fragmented MP4. For HEVC, `MediaSource.isTypeSupported` decides between playing and a clear message.
- **MPEG-2 (.100, .101):** a wasm build of an LGPL decoder, loaded only when a study contains MPEG-2.
- **Multi-frame ultrasound and cardiac:** cine playback at the recorded rate, with frame stepping.

**Gate:** playback checks in Chromium on the corpus video cases. The first frame is compared with an ffmpeg decode.

## F. Size limits

- **Packing:** the browser packer streams. It reads, encrypts and uploads one record at a time, and never holds a whole file in memory.
- **Uploads:** chunked and resumable, and they survive a page reload.
- **Storage:** large encrypted files live on disk next to the per-share SQLite, while the metadata stays in SQLite. Range reads stream from disk.
- **Limits:** the fixed 200 MiB body and 500 MiB share caps go. Quotas become server settings.

**Gate:** the 1.2 GB lung slide and a multi-GB synthetic CT share through `/share` on a phone and on a desktop. Peak browser memory stays bounded and is reported.

## G. Proof of coverage

- **Corpus cases:** each item in A–F adds cases or rendering checks with a reference.
- **IDC sweep:** a second stratified sweep over IDC adds non-image SOP classes and checks that each one is shown or listed, not only decoded.

## Still refused, with a message that names the format

- **JPIP referenced transfer syntaxes (.94, .95, .204, .205):** the file holds a link to a third-party image server, not pixels.
- **Hologic private tomosynthesis slices:** undocumented. The standard centre slice that accompanies them is shown.
- **Vendor compression in private tags:** undocumented.

## Order and owners

Five agents in parallel, each in its own directories. The coordinator verifies and commits after each wave.

| Agent | Workstream | Owns |
|---|---|---|
| Decoders | A | `codecs/`, `codec-corpus/` |
| Objects and display | B, C | `web/view/`, `web/core/` (non-WSI) |
| Slides | D | `web/core/wsi*`, `web/view/wsi-*` |
| Video | E | new `web/core/video*`, a `codecs/` demux crate |
| Scale | F | `crates/`, `web/share/` |

A and F go first, because B, D and E build on them. G runs inside each workstream and ends with the sweep.
