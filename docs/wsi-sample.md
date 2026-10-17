# Whole-slide public sample: recommendation

This is for the sandbox agent, to add a slide microscopy study to the public sample. The viewer side is described in `web/view/WSI.md`.

## Which slide

Use **CPTAC-LUAD, subject C3N-02231, H&E, from the NCI Imaging Data Commons.**
- IDC series_uuid: 4a6b5ed5-a7e8-450d-9af6-e739b1807bac.
- Download: `https://idc-open-data.s3.amazonaws.com/4a6b5ed5-a7e8-450d-9af6-e739b1807bac/<instance_uuid>.dcm`. The S3 listing with `?list-type=2&prefix=4a6b5ed5-a7e8-450d-9af6-e739b1807bac/` gives the seven keys.
- Study Instance UID: 2.25.336501483866813162542413772003169607549.
- Series Instance UID: 1.3.6.1.4.1.5962.99.1.249256810.1305925789.1640926796650.2.0.
- Scanner: Leica Aperio at 20×, converted by PixelMed `TIFFToDicom`.
- Encoding: JPEG baseline tiles of 240², TILED_FULL.
- License: CC BY 4.0.

Why this one:
- **Tissue.** It fills the glass slide, so every zoom level shows something.
- **Transfer syntax.** It is conformant JPEG baseline, the most common slide syntax in IDC. The JPEG 2000 slides in IDC (YBR_FULL_422 with subsampled chroma) are not conformant DICOM; they decode, but the case awaits a ruling.
- **Tested.** The whole slide passes the scripted checks in /view: tiles identical to pydicom and libjpeg, phone and desktop.

## Which instances to keep

The series has seven instances, 1.206 GB in total:

| Instance (IDC instance_uuid prefix) | Image Type | Size | Keep? |
|---|---|---|---|
| 6dc953bc | VOLUME, 73,703 × 46,849, 60,368 tiles, 0.49 µm/pixel | 1,052.2 MB | **No.** Too large for a sample |
| 8d7a5787 | VOLUME, 18,425 × 11,712, 3,773 tiles, 1.98 µm/pixel | 132.1 MB | Yes: the finest level of the sample |
| 7ef22e67 | VOLUME, 4,606 × 2,928, 260 tiles | 11.0 MB | Yes |
| 709a1540 | VOLUME, 2,303 × 1,464, 70 tiles | 3.6 MB | Yes |
| 4f7bec96 | OVERVIEW (photo of the whole glass slide; the label end is cropped dark) | 3.3 MB | Yes |
| dc7c0527 | THUMBNAIL | 2.3 MB | Optional; the viewer doesn't use it |
| 5633c6eb | LABEL: shows "C3N-02231-21" and a 2D barcode | 1.7 MB | **No.** The burned-in subject ID would contradict the fictional patient |

**Result.** Three pyramid levels, plus the overview and thumbnail, come to **152.3 MB** in one series (150.0 MB without the thumbnail). That is a real multi-level tiled pyramid of 4,103 tiles. At the finest level (about 2 µm per pixel) individual cells are visible.

The slide is its own study, so it is one encrypted file of about 152 MB. The server streams file uploads with no body limit; its only size limit is the per-share quota when one is set (`--max-share-bytes`; 20 GB on the public server), and the sample share is not counted against it.

The remaining instances still form a valid pyramid. Each instance carries its own Total Pixel Matrix, and they share the Pyramid UID and Frame of Reference.

**For a smaller sample,** drop the 18,425-wide level as well. That leaves 20 MB, with 4.6k pixels across at the finest. The streaming story then gets much weaker: the whole slide is only 20 MB.

## Header rewriting

The sandbox will rewrite the patient attributes to its fictional patient. CC BY 4.0 allows changes as long as there is attribution and an indication that the material was changed. The pixel data stays untouched.

Besides Patient Name, Patient ID and the dates, these attributes also carry the CPTAC subject or specimen:
- Clinical Trial Subject ID (0012,0040) is `C3N-02231`. The other Clinical Trial attributes (0012,0010–0031) name CPTAC-LUAD.
- Container Identifier (0040,0512) is `C3N-02231-21`.
- Specimen Description Sequence (0040,0560) holds specimen identifiers.
- Image Comments (0020,4000) holds the Aperio description, with the scan date and time, scanner ID and an original file name.
- Private group 0009 carries PixelMed's own attributes.

Keep every Study, Series, SOP Instance, Frame of Reference and Pyramid UID consistent across the kept instances. Keep the pixel attributes and the fragments of Pixel Data byte for byte. Rewriting the header changes its length, which is fine.

## Offset tables

None of the slide's instances has a frame offset table: each Basic Offset Table is empty and there is no Extended Offset Table. Without one, a viewer has to download every tile before the one it wants ([web/view/WSI.md, Offset tables](../web/view/WSI.md#offset-tables)). So the sample should carry a Basic Offset Table in each of the three tiled levels.

The sandbox build writes them (`imaging-sandbox/scripts/build-data.ts`, through `fillBasicOffsetTable` in `scripts/lib/dicom-rewrite.ts`). The packer's Rust code (`crates/shl-dicom-core/src/offset_tables.rs`) writes the same bytes: with the slide's three tables stripped, `shl-dicom-server pack --add-offset-tables` gives packed files identical to packing the built sample. The server seed also adds a table to any sample file that lacks one ([web/view/WSI.md, Offset tables](../web/view/WSI.md#offset-tables)).

The tables add 4 bytes per frame: 16 KB for the 3,773 + 260 + 70 tiles kept here. Fragment bytes are unchanged.

## Attribution text

Put this text with the sample, for example in the sample's study description note, on the landing page, and in the sandbox README:

> Slide image: CPTAC-LUAD, subject C3N-02231, from the National Cancer Institute Clinical Proteomic Tumor Analysis Consortium (CPTAC), distributed by the NCI Imaging Data Commons (https://imaging.datacommons.cancer.gov), DOI 10.5281/zenodo.12666813. Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changed: patient and specimen attributes replaced with a fictional patient; the label image and the full-resolution level were removed.

## Alternatives that were tested

Both of these pass the same checks. See `web/view/WSI.md`.
- **CPTAC-OV 17OV007** (series_uuid 5928613e-17d1-4182-84e8-12220d80ca11): 150.1 MB whole, 4 levels, and tissue that fills the slide. It is JPEG 2000 YBR_FULL_422, the non-conformant case.
- **CPTAC-BRCA 01BR006** (series_uuid 29368d94-3a65-4fdc-a796-9b1a48540c67): 177.1 MB whole, JPEG baseline. It is mostly empty glass with small tissue fragments, and drops to 21 MB without its base level.
