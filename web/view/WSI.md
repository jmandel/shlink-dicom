# Whole-slide images in /view

/view shows whole-slide microscopy (VL Whole Slide Microscopy Image, modality SM) as a deep-zoom pyramid. It fetches only the tiles on screen, each with one byte-range read of the encrypted series file. A 1.2 GB slide viewed at full resolution, with six pans, downloaded 13.8 MB, which is 1.15% of the slide.

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

Two cases stop after the first record:
- **Label, overview and thumbnail images.** Their attributes are enough, because they are read whole when shown.
- **Instances with a frame index in the Bundle** (see [Frame offsets](#frame-offsets-open-question-4)).

**Pyramid.** `buildPyramid` makes one level per Total Pixel Matrix width among the non-LABEL, non-OVERVIEW and non-THUMBNAIL instances, finest first. The first instance of each width is used.

**Tile to frame.**
- **TILED_FULL:** frame = `ty × tilesAcross + tx`. This is row-major order, with the first focal plane and optical path first.
- **TILED_SPARSE:** a map built from each frame's Plane Position (Slide) in the Per-frame Functional Groups.

**Frame to bytes** (`SlideSource.locate`). The sources are tried in this order:
1. the Bundle frame index (prototype extension, below);
2. the Extended Offset Table;
3. the Basic Offset Table;
4. native frame arithmetic;
5. walking the fragment item headers from the start of Pixel Data.

Walking (`FragmentWalker`) is sequential. It reads chunks that grow from 256 KiB to 4 MiB, and requests the next chunk while it parses the current one. It keeps what it learns for the page session, and stops when no tile is waiting.

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

**Stats panel** (bottom left; tap it to collapse). It shows:
- the bytes downloaded against the size of the series file, and the percentage;
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

**Not covered by the test data.**
- **TILED_SPARSE.** None of the 50,952 CC BY SM series of 100–700 MB in IDC is TILED_SPARSE, so that path is untested on real data.
- **Several focal planes or optical paths.** Only the first is shown.

## Running it

```sh
D=/media/barracuda/shlink-dicom-slides/dl
# The two smaller slides go through the local server's share API (one share each, two links each):
bun web/view/wsi-tools/wsi-fixtures.ts brca-jpeg=$D/29368d94-3a65-4fdc-a796-9b1a48540c67 ov-j2k=$D/5928613e-17d1-4182-84e8-12220d80ca11
# The 1.2 GB slide goes on a static host (U-mode link):
bun web/view/wsi-tools/static-host.ts &            # :3335, single-range GET + CORS
bun web/view/wsi-tools/static-pack.ts luad-1gb $D/4a6b5ed5-a7e8-450d-9af6-e739b1807bac
bun web/build.ts && node web/checks/wsi-checks.mjs  # 60 checks; shots and results.json in docs/shots/wsi/
```

The 1.2 GB slide is not on the local server, because the server's API accepts at most 200 MiB per upload body (`DefaultBodyLimit` in `crates/shl-dicom-server/src/lib.rs`) and 500 MiB per share. So a series over 200 MiB cannot be shared through `/share` today. `static-pack.ts` packs the slide as PROPOSAL §9 describes. It writes the series file next to two Bundles, one with the frame index and one without. `static-host.ts` serves them, the way any static host would (Appendix C).

`?frameindex=0` on /view ignores a Bundle frame index, for comparisons.

## Results

These were measured on 15 Oct 2026 in headless Chromium against localhost, with a load average of 5–14. Every request took a few milliseconds, so the times below show the client's own work, not what a real network would add.

- **Session:** the slide opens fitted to a 1440×900 window; then it zooms to full resolution on tissue, pans half a screen six times, and zooms back out with the wheel.
- **Phone:** 390×844 at DPR 3, using touch, at 0.75× full resolution.

| | brca-jpeg (177 MB) | ov-j2k (150 MB) | luad-1gb (1,206 MB) |
|---|---|---|---|
| First tile, from first request | 80 ms | 100 ms | 88 ms |
| First tile, from navigation (link resolved, Bundle decrypted, headers read) | 246 ms | 249 ms | 244 ms |
| First full-resolution tile after the zoom (frame index) | 25 ms | 32 ms | 26 ms |
| Desktop session, with the frame index | **5.1 MB (2.9%)**, 70 requests | **4.2 MB (2.8%)**, 59 requests | **13.8 MB (1.15%)**, 165 requests |
| Desktop session, walking fragment headers | 137 MB (77%) | 132 MB (88%) | 421 MB (35%) |
| Phone at full resolution on tissue | 2.2 MB (1.2%) | 2.6 MB (1.7%) | 5.3 MB (0.44%) |
| Tiles against the reference decode (16 per slide, 4 per level) | 0 differences | at most 2 | 0 differences |

**The reference decode** (`wsi-tools/ref_tiles.py`) runs pydicom 3.0.2 with pylibjpeg frame by frame: libjpeg for JPEG and OpenJPEG for JPEG 2000. For the YBR_FULL_422 JPEG 2000 slide it uses OpenJPEG's raw output (`raw=True`), because pydicom applies a second YCbCr conversion there (FORMAT.md). The tolerance is 2, the 9/7 float spread.

**Other checks** (`web/checks/wsi-checks.mjs`, 60 of 60 pass):
- desktop keyboard zoom and pan;
- the label sheet;
- on the phone: double tap 2×, pinch 4× for a 4× finger spread, a 120 px drag moving 120 CSS px, and a minimap tap;
- phone layout: no horizontal overflow, and every target at least 44 px;
- no console errors anywhere.

`node web/checks/view-checks.mjs` gives 145 of 154. The 9 failures check the old `/how`, `/share` and `/share/manage` placeholder text, which the How and Share agents have since replaced. No /view check fails.

## Frame offsets (open question 4)

**Without offsets, the client walks.** These PixelMed slides, like most WSI in IDC, have an empty Basic Offset Table and no Extended Offset Table. So the only way to know where frame *k* starts is to read every fragment item header before it. Fragments are a few KB long and records are 64 KiB, so that means fetching every record before frame *k*.

**What walking costs.** Reaching a base-level tile at fraction *f* of the instance costs about *f* × the instance size in downloaded bytes, in about 4 MiB requests. In the sessions above:
- brca-jpeg: tissue 73% of the way down, 134 MB walked, 41 requests;
- ov-j2k: 127 MB walked;
- luad-1gb: tissue about a third of the way down, 383 MB walked, 141 requests.

The worst case, the bottom-right tile, reads the whole base level: 1.05 GB for luad-1gb. On localhost the walk took about 1 s per 140 MB. At 50 Mbit/s, which was not measured, the same 383 MB would take about a minute. The coarse levels are small (0.8–25 MB) and are walked quickly. That is why the fitted first view costs the same in both modes.

**What the Bundle extension costs.** The prototype (`EXT_FRAMES` in `web/core/wsi.ts`) is optional. It is a complex extension on `ImagingStudy.series.instance`:
- `start` (`valueDecimal`): the instance offset of frame 0's first item header;
- `lengths` (`valueBase64Binary`): deflate-raw of one unsigned LEB128 per frame, the frame's bytes with its item headers included.

Frames are contiguous, so frame *k* is `[start + Σ lengths[<k], + lengths[k])`. A receiver that doesn't know the extension ignores it.

| | brca-jpeg | ov-j2k | luad-1gb |
|---|---|---|---|
| Frames indexed | 56,370 | 57,742 | 64,471 |
| Packer time to compute (it has every byte) | 28 ms | 65 ms | 644 ms |
| Bundle JWE without / with the index | 1.2 KB / 99 KB | 1.2 KB / 113 KB | 1.2 KB / 154 KB |
| Bytes per frame in the JWE | 1.74 | 1.93 | 2.37 |
| Header reads (no index → index) | 11 requests, 1.1 MB → 7, 0.6 MB | same | 11, 1.2 MB → 7, 0.66 MB |
| Bytes to the first full-resolution screen (walk → index) | 135 MB → 2.5 MB | 128 MB → 2.0 MB | 383 MB → 5.9 MB |

The index also shrinks the header reads. Each instance needs only its first record, because `start` replaces finding Pixel Data. One trade-off: Pixel Spacing, which sits in the Shared Functional Groups after the ICC profile, is then not read. Nothing uses it yet; a scale bar would.

**Recommendation.** Make it an optional extension. The packer computes it when it can (an encapsulated instance with more than one frame), and receivers use it when present.

Reasons for it:
- It costs about 2 bytes per frame of Bundle, about 100 KB per typical slide. In exchange, a receiver can go to any tile at any depth in one range read, instead of walking up to the whole instance.
- It also helps any multi-frame encapsulated instance without offsets: cine ultrasound, enhanced MR, tomosynthesis.
- It is the only remedy that keeps the files byte-identical. PROPOSAL §11.1 limits the sharer to adding the Part 10 wrapper, so adding an EOT to the file is out.

Points for the coordinator:
- **Threshold.** Skipping instances with few frames, or with a usable BOT or EOT, keeps CT and MR Bundles as they are. The prototype indexes every encapsulated multi-frame instance.
- **Encoding.** A plain JSON array of lengths, left to the JWE's own DEFLATE, came out about 10% smaller in the JWE (87 KB for brca-jpeg). But it is about 5 characters per frame in the decrypted JSON (around 300 KB) and in memory. The base64 form keeps the decrypted Bundle near its compressed size.
- **A sidecar.** A per-series `{fileId}.idx`, encrypted under the series key, would keep the Bundle small and be fetched only when a viewer zooms. It would add a file type to the fetch contract. The measurements above apply to it unchanged, apart from one more request.

The prototype lives in the Bundle only for test links (`wsi-tools/wsi-fixtures.ts`, `static-pack.ts`). The packer in `crates/` does not write it.

## Limits

- **Focal planes and optical paths.** Only the first focal plane and optical path are shown. Z-stacks and multiplexed fluorescence channels are not selectable.
- **Learned offsets.** Walking results last for the page session. They are not stored across visits, though they could be, by fileId, since series files are immutable.
- **Large uploads.** Series over 200 MiB cannot be uploaded through the local server's API (see above).
- **Fetch granularity.** The smallest fetch is a 64 KiB record, and tiles here average 3–17 KB. Neighbouring tiles share records, but a scattered view still over-fetches several times its tile bytes. That is the format's record size (PROPOSAL §9.3), not something the viewer can change.
- **Downloads.** For a slide, "Download originals" offers the study or series ZIP, not "This image". The ZIP of a 1.2 GB series was not tried.
- **Monochrome slides.** These are shown with a min/max window. There is no window/level control for slides.
