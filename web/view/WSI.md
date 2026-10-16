# Whole-slide images in /view

/view shows whole-slide microscopy (VL Whole Slide Microscopy Image, modality SM) as a deep-zoom pyramid. It fetches only the tiles on screen, each with one byte-range read of the encrypted file. A 1.2 GB slide viewed at full resolution, with six pans, downloaded 14.6 MB, which is 1.21% of the slide. That figure needs frame offset tables in the files; the packer can add them ([Offset tables](#offset-tables)).

## How it works

**Detection.** A series is a slide when its modality is SM, or when any instance has SOP Class 1.2.840.10008.5.1.4.1.1.77.1.6 (`isSlideSeries` in `web/core/wsi.ts`). Slide series never go through the slice viewer's `ImageStore`, which would decode a whole instance.

**Headers.** The pyramid attributes are in each instance's DICOM header, not in the Bundle. `SlideSource.open` reads each instance's first record (64 KiB) in parallel and parses it with `parseSlideHeader`. That gives:
- Total Pixel Matrix Columns and Rows;
- Rows and Columns (the tile size);
- Number of Frames;
- Dimension Organization Type;
- Image Type;
- the pixel attributes;
- Shared and Per-frame Functional Groups;
- the Extended Offset Table;
- the position of Pixel Data and the Basic Offset Table.

When the header runs past what was read, the next read grows by at least 2.5× to the end of the record holding the byte needed. The PixelMed headers here are about 147 KB, mostly ICC profile, so a full header takes two reads.

Label, overview and thumbnail images stop after the first record: their attributes are enough, because they are read whole when shown. A filled Basic Offset Table adds 4 bytes per frame to the header read (211 KB for a 52,772-frame level).

**Pyramid.** `buildPyramid` makes one level per Total Pixel Matrix width among the non-LABEL, non-OVERVIEW and non-THUMBNAIL instances, finest first. Every instance of a level contributes frames, so a level can be spread over several instances: one per fluorescence channel, one per focal plane, or concatenations.

**Optical paths and focal planes.** The pyramid lists:
- **Optical paths:** from each instance's Optical Path Sequence, ordered by identifier. Their labels come from Optical Path Description.
- **Focal planes:** Z offsets in µm when the files give them (per frame, or in the Shared Functional Groups); otherwise plane numbers.

Each level maps (tile, plane, path) to an instance and a frame.

**Tile to frame.**
- **TILED_FULL:** column varies fastest, then row, then focal plane, then optical path (PS3.3 C.8.12.4). So frame = ((path × planes) + plane) × tiles + `ty × tilesAcross + tx` within the instance that holds that path and plane.
- **TILED_SPARSE:** each frame's Plane Position (Slide) gives its tile. Its Z Offset in Slide Coordinate System gives the plane, and its Optical Path Identification the path. Tiles with no frame are left empty, so background the scanner skipped is not fetched.

**Frame to bytes** (`SlideSource.locate`). The sources are tried in this order:
1. the Extended Offset Table;
2. the Basic Offset Table;
3. native frame arithmetic;
4. walking the fragment item headers from the start of Pixel Data.

Walking (`FragmentWalker`) is sequential. It keeps what it learns for the page session, and stops when no tile is waiting.
- **Chunk size:** the first chunk is 256 KiB. Later chunks are sized to about 0.4 s at the measured speed (256 KiB to 4 MiB), so progress moves several times a second on a slow connection and requests stay few on a fast one.
- **Read-ahead:** the next chunk is requested while the current one is parsed.

**Progress.** A card near the image says what is happening:
- **While fragment headers are walked:** "Finding tiles: 42.0 MB of about 379 MB read · 50.3 MB downloaded", with a bar. The estimate scales the bytes read so far by the furthest frame a tile is waiting for, so it settles as the walk goes.
- **When wanted tiles have been missing for more than 300 ms:** "Loading tiles: 12 of 40 · 3.1 MB downloaded".

The coarsest level and the minimap come first, and pan and zoom are handled on the next frame throughout. A slide with a level that has no offset table carries one line under its title: "This slide has no frame offset table, so the viewer has to read ahead to find tiles. Adding tables when sharing avoids this." 

A fragment starts a new frame when it begins with a codestream start marker: SOI for JPEG and JPEG-LS, SOC or a JP2 signature box for JPEG 2000 and HTJ2K. So frames split over several fragments are handled. Every other syntax is treated as one fragment per frame.

**Reads.** `SeriesReader` (`web/core/wsi-source.ts`) does the reading:
- **Record cache.** It caches verified, decrypted 64 KiB records, with a 64 MiB budget.
- **Merging.** Adjacent missing records go in one Range request, of up to 4 MiB.
- **Queue.** Requests run through a priority queue, six at a time.
- **Cancellation.** Queued requests that every waiter has abandoned are dropped.

Decryption is the core's `WebCryptoDecryptor`. Adjacent tiles of a row are adjacent in the file, so one record usually serves several tiles.

**Decode.** For each tile, `singleFrameFile` builds a minimal Part 10 file of about 300 bytes. It holds the pixel attributes, Number of Frames 1 and the frame's own fragment items. The file goes to `pool.decode` in the viewer-kit workers.

The pool's `decodeFrames` was not used, because for a single frame it adds a probe round trip and then calls `decode` anyway. No addition to viewer-kit was needed.

**Large files.**
- No pyramid level is ever decoded whole. Only single frames are decoded, plus label, overview and thumbnail images under 48 MiB (`WHOLE_DECODE_LIMIT`).
- Each wasm decode sees one tile, about 240² × 3 bytes out, so the 4 GB wasm limit is far away.
- The main thread does header parsing, the RGB to RGBA copy for each tile, and drawing. Its longest task in the checks was 66 ms.

**Drawing** (`web/view/wsi-view.ts`).
- **Canvas.** A canvas 2D tile layer draws ImageBitmaps with `drawImage`, which the GPU composites. It needs no WebGL context.
- **Level.** The level is the coarsest one with at least one level pixel per 1.5 CSS pixels. This keeps phones (DPR 3) and the 4× gaps between levels from fetching hundreds of tiles.
- **Order.** Visible tiles load nearest to the centre first. The next coarser level loads at Near priority.
- **Cancellation.** Tiles that leave the view are cancelled, both queued reads and queued decodes.
- **Placeholders.** The coarsest level is always loaded and never evicted. It is the placeholder under tiles still loading, the minimap, and the overview thumbnail.
- **Tile cache.** Decoded tiles are kept as ImageBitmaps with a byte budget: 32 MiB × deviceMemory, between 96 and 384 MiB.

**Interaction.**
- **Touch:** drag pans; pinch zooms about the fingers' midpoint; double tap zooms 2×.
- **Mouse:** the wheel zooms at the cursor (trackpad pinch included); double-click zooms in, and Shift with double-click zooms out.
- **Keyboard:** the arrows pan, `+` and `−` zoom, and `0` fits the slide.
- **Minimap:** tap or drag on it to move there.
- **Label:** the Label button shows the label and glass-slide images, read when asked for.
- **Focus:** a Focus control in the toolbar appears when the slide has several focal planes. Page Up and Page Down also move focus. While the new plane loads, the nearest plane's tiles stand in.

**Fluorescence.** A slide whose images are single-sample and has several optical paths is drawn as a composite:
- **Windows:** each channel's tiles become grey through that channel's window, the 0.5th to 99.8th percentile of its first decoded tile (8- or 16-bit).
- **Compositing:** each visible channel is drawn on its own layer, tinted with its colour (canvas "multiply"), then added to the picture ("lighter") with its intensity (a brightness filter).
- **Defaults:** the first four channels are shown. Nuclear stains (DAPI, Hoechst, "nuclei") are blue; other channels get the colour of their Illumination Wave Length when given, else a palette colour.
- **Controls:** the Channels sheet (Layers, when there are overlays too) has, for each channel, a checkbox, a colour picker and an intensity slider (0–400%). Only visible channels are fetched.

**Colour profiles.** When the optical path carries an ICC profile that is not sRGB, each RGB tile is converted to sRGB before drawing. The transform is `iccToSrgb` in `web/core/icc.ts`, shared with the photo display:
- **Profile types:** matrix/TRC and lut8/lut16 profiles, into an XYZ or Lab connection space.
- **Method:** the profile's default (perceptual) intent is sampled once into a 33³ table and applied with trilinear interpolation.
- **Cost:** about 2 ms per 240² tile, plus 27 ms once to build the table.
- **Control:** a checkbox in the Layers sheet switches it off.

The Aperio "ScanScope v1" profile on the CPTAC slides is a lut16 into Lab; the TCGA slide here carries sRGB, so nothing is done.

**Annotations and segmentations.** Bulk Simple Annotations (ANN) and slide segmentations (SEG) are found among the study's other series by their Referenced Series Sequence. That costs one small header read per candidate instance. They are listed in the Layers sheet and read only when switched on.
- **Annotations** (`web/core/wsi-ann.ts`):
  - Graphic types: points, polylines, polygons, ellipses and rectangles, in 2D (total pixel matrix) or 3D (slide coordinates, placed with the slide's origin, orientation and spacing).
  - Drawing: a grid index means only annotations on screen are drawn. Annotations under 3 screen pixels are drawn as dots.
  - Colours: the group's Recommended Display CIELab Value, else a palette colour.
- **Segmentations:**
  - Read as tiled pyramids of their own, with segments in the place of optical paths.
  - Each segment is drawn in its recommended colour: binary masks at fixed opacity, fractional values as opacity.
  - Placement on the slide uses the two images' pixel spacing and origin.
  - 1-bit frames that begin mid-byte (PS3.5 packs bits across frames) are re-aligned before decoding.

**JPEG XL.** Tiles in the three JPEG XL syntaxes (.110 lossless, .111 JPEG recompression, .112) decode through the same pool, using the decoders' JPEG XL support. Fragment walking recognises JPEG XL codestreams and containers.

**Stats panel** (bottom left; tap it to collapse). It shows:
- the bytes downloaded against the size of the slide's records in its encrypted file, and the percentage;
- tiles decoded and requests made;
- the current level;
- time to first tile, measured from the slide's first request to its first decoded tile;
- where the frame offsets came from (and, while walking, how many frames are located so far).

## Test data

All three slides are from the NCI Imaging Data Commons. Each is CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) and was found with `wsi-tools/sm_series.sql` and `sm_series_large.sql`; the DOIs come from `sm_provenance.sql`. Four queries were run, each under 15 GB processed (38 GB in total, billed to fhir-org-starter-project). Every slide is Leica Aperio, converted by PixelMed `TIFFToDicom`. None of them has a Basic or Extended Offset Table: each BOT is empty.

| Name in the checks | Collection | Source DOI | Size | Levels (finest first) | Transfer syntax |
|---|---|---|---|---|---|
| `brca-jpeg` | CPTAC-BRCA, subject 01BR006 | 10.5281/zenodo.12666759 | 177.1 MB, 7 instances | 75,695×40,055 (52,772 tiles of 240²), 18,923×10,013, 4,730×2,503, 2,365×1,251 | JPEG baseline, RGB; label, overview and thumbnail are Explicit VR LE |
| `ov-j2k` | CPTAC-OV, subject 17OV007 | 10.5281/zenodo.12666842 | 150.1 MB, 7 instances | 49,920×70,825 (54,015 tiles of 256²), 12,480×17,706, 3,120×4,426, 1,560×2,213 | JPEG 2000 lossy, YBR_FULL_422 with 2×1 chroma subsampling (the sYCC case in `codec-corpus/formats/jpeg2000/FORMAT.md`) |
| `luad-1gb` | CPTAC-LUAD, subject C3N-02231 | 10.5281/zenodo.12666813 | 1,206.1 MB, 7 instances | 73,703×46,849 (60,368 tiles of 240²), 18,425×11,712, 4,606×2,928, 2,303×1,464 | JPEG baseline, RGB |

UIDs:
- `brca-jpeg`:
  - IDC series_uuid 29368d94-3a65-4fdc-a796-9b1a48540c67;
  - Study 2.25.25148242785680290844136875845052620468;
  - Series 1.3.6.1.4.1.5962.99.1.151467892.1038561512.1640829007732.2.0.
- `ov-j2k`:
  - IDC series_uuid 5928613e-17d1-4182-84e8-12220d80ca11;
  - Study 2.25.66653443688849512858095751273840469208;
  - Series 1.3.6.1.4.1.5962.99.1.267134128.1983115907.1640944673968.2.0.
- `luad-1gb`:
  - IDC series_uuid 4a6b5ed5-a7e8-450d-9af6-e739b1807bac;
  - Study 2.25.336501483866813162542413772003169607549;
  - Series 1.3.6.1.4.1.5962.99.1.249256810.1305925789.1640926796650.2.0.

Attribution: "National Cancer Institute Clinical Proteomic Tumor Analysis Consortium (CPTAC), via the NCI Imaging Data Commons. CC BY 4.0." Cite the DOI in the table for each slide.

The files are in `/media/barracuda/shlink-dicom-slides/dl/<series_uuid>/`, kept local only.

### Feature test data

A census query (`wsi-tools/sm_features.sql`, 7.2 GB) over every SM, ANN and tiled SEG instance in IDC found:
- **Present under CC BY:** bulk annotations (TCGA, 1,087 series in TCGA-BRCA alone) and tiled segmentations (TCGA).
- **Fluorescence:** a per-study query (`sm_studies.sql`, 9.2 GB) found fluorescence slides with one channel per instance in the HTAN collections.
- **Absent under CC BY:** no slide has a Total Pixel Matrix Focal Planes or Number of Optical Paths above 1, none is TILED_SPARSE, and none is JPEG XL. Those were built from real slides with `wsi-tools/build_synthetic.py` (pydicom, imagecodecs, cjxl); each built file says it is synthetic in its Series Description.

| Name | What | Source | License |
|---|---|---|---|
| `ann-seg` | TCGA-05-5425 DX1, FFPE H&E: JPEG 2000, 2 levels, 10.6 MB, sRGB ICC profile. With it: Bulk Simple Annotations, 9,856 nucleus polygons (2.1 MB); a nuclei SEG pyramid, binary, 3 levels; and three Stony Brook TIL maps, binary, fractional, and two segments | TCGA-LUAD in IDC: study 2.25.205030765177901157267000321305282297826 (IDC crdc 26f5b0cf-9995-49f4-bdef-389abd895754); slide series 1.3.6.1.4.1.5962.99.1.1068929117.2018545680.1637451501661.2.0 (IDC 5b454b12-b716-471d-abde-f59ec88cf4ef); ANN cdd04f64-c03b-47ef-bcce-528317edeb10, SEG 47b2be3f-c5b7-473f-a444-b48f6e3e9ce1, 5192a672-eff2-400d-848d-d4a18ab4e021, 992b538e-a3f9-4ced-941a-5c1dd732867b, ac7cef6d-69d1-4b32-a5a9-8b12d923e41b | CC BY 4.0 |
| `fluor-ohsu` | Multiplex immunohistochemistry, 12 channels (one per instance), 5 levels, 8-bit, uncompressed, 126 MB | HTAN-OHSU, series b67a9aee-2f12-4e9d-9e00-7130e5017545, Series Instance UID 1.3.6.1.4.1.5962.99.1.1999891937.339225835.1655562333665.4.0 | CC BY 4.0 |
| `fluor-16bit` | Imaging mass cytometry, 28 channels, 16-bit, one level, 5 MB | HTAN-WUSTL, series 76cce1d6-61fa-4ced-bb8f-3695eb76758e, Series Instance UID 1.3.6.1.4.1.5962.99.1.1997745066.816859639.1655560186794.4.0 | CC BY 4.0 |
| `fluor-3path` | Synthetic: three of the OHSU channels in one instance per level (Number of Optical Paths 3) | from `fluor-ohsu` | CC BY 4.0 (changed) |
| `sparse-z` | Synthetic: DX1 as TILED_SPARSE with three focal planes (Z −2, 0, +2 µm; the outer two blurred by about 1.5 and 3 µm), 223 background tiles left out, frames shuffled, JPEG baseline | from `ann-seg` DX1 | CC BY 4.0 (changed) |
| `full-z` | Synthetic: the same three planes, TILED_FULL, all planes in one instance per level | from `ann-seg` DX1 | CC BY 4.0 (changed) |
| `jxl-lossless`, `jxl-lossy` | Synthetic: DX1 re-encoded as JPEG XL lossless (.110) and JPEG XL distance 1 (.112) | from `ann-seg` DX1 | CC BY 4.0 (changed) |
| `jxl-recompress` | Synthetic: TCGA-05-5425 BS2 (frozen H&E, JPEG baseline, ScanScope v1 ICC profile) with its JPEG tiles losslessly recompressed by cjxl (.111); the 12,000-wide base level left out | TCGA-LUAD, series 62828643-1ae6-4e24-b0e7-16b88a8d548b | CC BY 4.0 (changed) |

TCGA attribution: "The Cancer Genome Atlas (TCGA) Research Network, via the NCI Imaging Data Commons. CC BY 4.0." HTAN attribution: "Human Tumor Atlas Network (HTAN), OHSU and WUSTL centers, via the NCI Imaging Data Commons. CC BY 4.0." The synthetic files are in `/media/barracuda/shlink-dicom-slides/synthetic/`.

## Running it

```sh
D=/media/barracuda/shlink-dicom-slides/dl
# The two smaller slides go through the local server's share API: two shares each, one packed as
# the files are (plainLink) and one with the packer's offset-table option (tablesLink):
bun web/view/wsi-tools/wsi-fixtures.ts brca-jpeg=$D/29368d94-3a65-4fdc-a796-9b1a48540c67 ov-j2k=$D/5928613e-17d1-4182-84e8-12220d80ca11
# The 1.2 GB slide goes on a static host (U-mode links), as it is and with offset tables:
bun web/view/wsi-tools/static-host.ts &            # :3335, single-range GET + CORS
bun web/view/wsi-tools/static-pack.ts luad-1gb $D/4a6b5ed5-a7e8-450d-9af6-e739b1807bac
bun web/build.ts && node web/checks/wsi-checks.mjs  # 60 checks; shots and results.json in docs/shots/wsi/
node web/checks/share-checks.mjs --only=slide       # /share with the slide minus its base level
# Feature fixtures (one share each, packed with offset tables), then the feature checks:
cd codec-corpus && uv run python -I ../web/view/wsi-tools/build_synthetic.py /media/barracuda/shlink-dicom-slides/synthetic && cd ..
S=/media/barracuda/shlink-dicom-slides
bun web/view/wsi-tools/wsi-fixtures.ts --tables-only ann-seg=$S/staged/ann-seg fluor-ohsu=$S/dl/b67a9aee-2f12-4e9d-9e00-7130e5017545 \
  fluor-16bit=$S/dl/76cce1d6-61fa-4ced-bb8f-3695eb76758e fluor-3path=$S/synthetic/fluor-3path sparse-z=$S/synthetic/sparse-z \
  full-z=$S/synthetic/full-z jxl-lossless=$S/synthetic/jxl-lossless jxl-lossy=$S/synthetic/jxl-lossy jxl-recompress=$S/synthetic/jxl-recompress
node web/checks/wsi-checks.mjs --only=features      # or --only=<fixture>, icc, jxl
```

`staged/ann-seg` holds links to the DX1, ANN and SEG files of the TCGA study.

The server takes the 1.2 GB slide like any other share: file uploads stream to disk with no body limit, and the only size limit is the per-share quota when one is set (`--max-share-bytes`; 20 GB on the public server). `static-pack.ts` packs a slide for a static host instead, as spec §9 describes, writing two encrypted files and a Bundle for each. Its offset tables come from the same Rust code as the packer's, through `offset_table_patch_wasm`. `static-host.ts` serves them, the way any static host would (Appendix C).

## Results

These were measured on 15 Oct 2026 in headless Chromium against localhost, with a load average of 5–14. Every request took a few milliseconds, so the times below show the client's own work, not what a real network would add.

- **Session:** the slide opens fitted to a 1440×900 window; then it zooms to full resolution on tissue, pans half a screen six times, and zooms back out with the wheel.
- **Phone:** 390×844 at DPR 3, using touch, at 0.75× full resolution.

| | brca-jpeg (177 MB) | ov-j2k (150 MB) | luad-1gb (1,206 MB) |
|---|---|---|---|
| First tile, from first request | 94 ms | 144 ms | 67 ms |
| First tile, from navigation (link resolved, Bundle decrypted, headers read) | 256 ms | 310 ms | 213 ms |
| First full-resolution tile after the zoom (offset tables added) | 26 ms | 31 ms | 29 ms |
| Desktop session, offset tables added | **6.2 MB (3.5%)**, 76 requests | **5.2 MB (3.5%)**, 66 requests | **14.6 MB (1.21%)**, 175 requests |
| Desktop session, files as they are (walking fragment headers) | 137 MB (77%) | 132 MB (88%) | 421 MB (35%) |
| Phone at full resolution on tissue, offset tables added | 3.5 MB (2.0%) | 3.6 MB (2.4%) | 5.9 MB (0.49%) |
| Tiles against the reference decode (16 per slide, 4 per level) | 0 differences | at most 2 | 0 differences |

**The reference decode** (`wsi-tools/ref_tiles.py`) runs pydicom 3.0.2 with pylibjpeg frame by frame: libjpeg for JPEG and OpenJPEG for JPEG 2000. It decodes the original files, so these comparisons also show that the rewrite left the frames intact. For the YBR_FULL_422 JPEG 2000 slide it uses OpenJPEG's raw output (`raw=True`), because pydicom applies a second YCbCr conversion there (FORMAT.md). The tolerance is 2, the 9/7 float spread.

**Other checks** (`web/checks/wsi-checks.mjs`, 60 of 60 pass):
- desktop keyboard zoom and pan;
- the label sheet;
- on the phone: double tap 2×, pinch 4× for a 4× finger spread, a 120 px drag moving 120 CSS px, and a minimap tap;
- phone layout: no horizontal overflow, and every target at least 44 px;
- no console errors anywhere.

### Feature results

These come from `wsi-checks.mjs`, which ran 144 of 144 checks on 15 Oct 2026. Every tile below is compared with a reference decode of the same frame (`ref_tiles.py`).

| Feature | Check | Result |
|---|---|---|
| Fluorescence, 12 channels | Tiles of 3 channels × 2 levels against pydicom | identical |
| | Switching a channel off in the sheet; intensity 200% | the picture changes; brighter |
| | Full resolution at the centre, 4 channels | 30.9 MB of 131.8 MB on desktop, 17.3 MB on the phone (uncompressed 1024² tiles: 1 MB per tile per channel) |
| Fluorescence, 16-bit and three paths in one instance | Tiles against pydicom | identical |
| Focal planes, TILED_SPARSE and TILED_FULL | Tiles of all three planes against pydicom; Focus control (keyboard on desktop, tap on phone); Page Up | identical; the picture changes |
| TILED_SPARSE | A background tile absent from the file | reported absent, left empty |
| Annotations | 9,856 polygons drawn at fit; outline at the first polygon's first point | drawn |
| Segmentations | 1-bit tiles of the nuclei pyramid, and both segments of a TIL map whose second frame starts mid-byte, against pydicom | identical |
| Layers cost | Annotations and the nuclei segmentation, read when switched on | 2.8 MB, after 1.1 MB for the slide |
| ICC (ScanScope v1, lut16 → Lab) | Corrected tiles against lcms2 (ImageMagick) | max 1, mean ≤ 0.03; switched off: the stored pixels exactly |
| JPEG XL lossless / lossy / JPEG recompression | Tiles against libjxl (imagecodecs) | identical / max 1 / max 1 (inverse DCT rounding) |

**Slow connection, no offset tables** (`--only=throttled`): brca-jpeg packed without tables, at 20 Mbit/s with 40 ms latency (CDP network emulation), zoomed to full resolution on tissue, sampled for 12 s, on desktop and phone.

| Gate | Result |
|---|---|
| Progress shown within 500 ms | 105–110 ms |
| Its text changes at least every second | longest gap 300–402 ms over 120+ samples |
| No main-thread task over 100 ms | none in 6 of 7 runs; one desktop run had tasks of 118 and 165 ms (load average 10–14 from other agents) |
| Pan and zoom answered during the walk | next frame (0–33 ms after the input) |
| Walked in 12 s | about 30 MB of the roughly 134 MB this view needs |

On the full colour cube, `iccToSrgb` matches lcms2 with a mean difference of 0.15 and a 99th percentile of 3. The largest differences, up to 11, are in saturated out-of-gamut greens (`wsi-tools/icc-check.ts`).

## Offset tables

**Without offset tables, the client walks.** These PixelMed slides, like most whole-slide images in IDC, have an empty Basic Offset Table and no Extended Offset Table. So the only way to know where frame *k* starts is to read every fragment item header before it. Fragments are a few KB long and records are 64 KiB, so that means fetching every record before frame *k*.

**What walking costs.** Reaching a base-level tile at fraction *f* of the instance costs about *f* × the instance size in downloaded bytes, in requests of up to 4 MiB. In the sessions above:
- brca-jpeg: tissue 73% of the way down, 134 MB walked, 41 requests;
- ov-j2k: 127 MB walked;
- luad-1gb: tissue about a third of the way down, 378 MB walked, 122 requests.

The worst case, the bottom-right tile, reads the whole base level: 1.05 GB for luad-1gb. On localhost the walk took about 1 s per 140 MB. At 50 Mbit/s, which was not measured, 378 MB would take about a minute.

**Adding them when packing.** Josh decided that offsets go in the files, not the Bundle. When asked, the packer fills in the table for each encapsulated multi-frame instance that has an empty BOT and no EOT. The code is `crates/shl-dicom-core/src/offset_tables.rs`, turned on by `IngestSession::set_add_offset_tables`, so it is the same for every packer:
- the CLI: `shl-dicom pack --add-offset-tables`;
- the server seed;
- the browser: `offset_table_patch_wasm` (shl-dicom-wasm), one file at a time;
- /share: a box in the review step, shown only when such files are present.

How it works:
- **Which table.** It writes a Basic Offset Table, or an Extended Offset Table (offsets and lengths, inserted before Pixel Data) when an offset passes 4 GiB. The EOT case needs one fragment per frame, as PS3.5 A.4 requires. It never writes both tables.
- **What changes.** Fragment bytes are unchanged; only the bytes before the first fragment item change. The instance's length in the Bundle is its new length.
- **When it declines.** It leaves an instance alone when frame boundaries are ambiguous. Boundaries come from codestream start markers that must count exactly Number of Frames, or from exactly one fragment per frame.

**What it costs and saves:**

| | brca-jpeg | ov-j2k | luad-1gb |
|---|---|---|---|
| Frames | 56,370 | 57,742 | 64,471 |
| Bytes added (4 per frame) | 225 KB (0.13%) | 231 KB (0.15%) | 258 KB (0.02%) |
| Header reads (as they are → tables added) | 11 requests, 1.1 MB → 13, 1.6 MB | 11, 1.1 MB → 13, 1.6 MB | 11, 1.2 MB → 12, 1.4 MB |
| Bytes to the first full-resolution screen (as they are → tables added) | 135 MB → 3.7 MB | 128 MB → 3.2 MB | 379 MB → 6.6 MB |

**Earlier prototype.** It put the offsets in the Bundle instead: about 2 bytes per frame, 99–154 KB of JWE. That reached the same screens with 2.5, 2.0 and 5.9 MB, because its header reads were smaller. Josh chose tables in the files, so the prototype is gone.

**/share, end to end** (`share-checks.mjs --only=slide`): the CPTAC-LUAD slide without its base level, 152 MB with three levels.
- **With the box on (the default):** full resolution at the slide's centre took 7.4 MB (4.8%) on desktop and 5.4 MB on the phone, with no walking. /view read a Basic Offset Table at every level.
- **With the box off:** the same view took 103 MB (67%).

## Limits

- **One focal plane at a time.** There is no extended-depth or stacked view.
- **Fluorescence:**
  - each channel's window is fixed from its first tile, with no per-channel black or white point control;
  - channels may be windowed on an inconsistent level if their first decoded tile is unrepresentative.
- **Overlays:**
  - Segmentations and annotations are placed by spacing and origin. Rotated or flipped slide orientations relative to the slide image are not handled.
  - An annotation instance is read whole (up to 512 MB). Its measurements (for example nucleus area) are not shown.
- **ICC profiles:** v4 lutAtoB profiles (mAB) are not converted. The table is built on the main thread (27 ms).
- **Learned offsets.** For files shared without tables, walking results last for the page session. They are not stored across visits, though they could be, by file id and offset, since the encrypted files are immutable.
- **Fetch granularity.** The smallest fetch is a 64 KiB record, and tiles here average 3–17 KB. Neighbouring tiles share records, but a scattered view still over-fetches several times its tile bytes. That is the format's record size (spec §9.3), not something the viewer can change.
- **Downloads.** For a slide, "Download originals" offers the study or series ZIP, not "This image". The ZIP of a 1.2 GB series was not tried.
- **Single-channel monochrome slides.** These are shown with a percentile window. There is no window/level control for slides.
