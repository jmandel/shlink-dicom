# Object-type sweep of IDC

The earlier long-tail sweep ([LONGTAIL.md](LONGTAIL.md)) chose IDC files by pixel encoding, and it tested the decoders. This sweep chooses them by object type (SOP class) and tests what the viewer does with each kind of object. The method:
- every series is packed into a share with the Share page's packer;
- the share is opened in `/view` in headless Chromium;
- the viewer is checked for what that type calls for.

The counts it draws on are in [SOPCLASS_CENSUS.md](SOPCLASS_CENSUS.md).


## Status of the defects (16 Oct 2026)

| # | Defect | Status |
|---|---|---|
| 1 | PET reformats with per-slice rescale | Fixed in ec827af (volumes on one real-value scale) |
| 2 | Per-frame items numbered 0 in the decoder | Fixed in eacfeb3 |
| 3 | Out-of-order frames step in stored order | Fixed in ec827af |
| 4 | SEG drawn through the image's grid, upside down for NLST | Fixed in ec827af (placed through its own geometry) |
| 5 | GSPS opens the wrong image | Fixed in ec827af |
| 6 | Deflated label-map SEGs dropped at Share ingest | Fixed in cb70e6b (header reads inflate deflated data sets) |
| 7 | Breast Projection For Processing draws black | Fixed in ec827af (percentile window when the stored one covers under 1% of values) |

All seven regression fixtures pass.

## Summary

- **156 cases covering 43 SOP classes:** all 38 in IDC v25, plus five IDC lacks. Enhanced CT and MR came from public test corpora; Legacy Converted Enhanced CT, MR and PET were derived from IDC series. The data took 8.1 GB of scratch space. Only UIDs and metadata are committed.
- **120 cases pass, 22 fail and 14 are unsupported.** "Unsupported" means the viewer labels the object as not displayed and offers a download.
- **The 22 failures come from seven defects**, each with a regression fixture. Three are in how the viewer reads per-frame and per-slice values, which the earlier sweep never reached:
  1. Reformats are wrong for PET series whose rescale differs between slices. Two thirds of IDC's PET series have such a rescale.
  2. The decoder applies frame 1's per-frame rescale and window to every frame.
  3. A multi-frame image whose frames are stored out of spatial order steps in stored order.

  The other four:
  4. A segmentation stored with its rows in the opposite order to its image's is drawn upside down. This happens with the NLST TotalSegmentator segmentations, the largest group of SEG in IDC.
  5. A presentation state opens its series without moving to the image it names.
  6. The Share page's reader drops a Deflated label-map segmentation.
  7. A Breast Projection For Processing image draws black under its stored window.
- **Enhanced and Legacy Converted volumes otherwise work.** Frames become slices, and reformats built from per-frame geometry match SimpleITK exactly for Legacy Converted CT and MR, also when the frames are shuffled. The viewer refuses to reformat multi-stack Enhanced CT and MR, and says why.
- **Objects the viewer does not display are labelled, with a download.** These are Raw Data, RT Plan, Spatial Registration, Real World Value Mapping and Advanced Blending Presentation State. None caused a page error.

## How it was run

| Step | Tool | Output (scratch: `/media/barracuda/sop-sweep/`) |
|---|---|---|
| Census | [sql/sopclass_census.sql](sql/sopclass_census.sql) via `longtail_bq.py` | [SOPCLASS_CENSUS.md](SOPCLASS_CENSUS.md) |
| Per-slice rescale | [sql/sopclass_rescale_varies.sql](sql/sopclass_rescale_varies.sql) | counts and small examples |
| SEG orientation | [sql/sopclass_seg_orientation.sql](sql/sopclass_seg_orientation.sql) | counts by column direction |
| Selection | [sopclass_select.py](../scripts/sources/sopclass_select.py), from the `idc-index` series table (IDC v25) | `selection.json`: 147 series |
| Download, with referenced series | [sopclass_fetch.py](../scripts/sources/sopclass_fetch.py) (public bucket `idc-open-data`) | `dl/<SeriesInstanceUID>/`, `cases.json` |
| Classes IDC lacks | [sopclass_extra.py](../scripts/sources/sopclass_extra.py), [sopclass_derive.py](../scripts/sources/sopclass_derive.py) (highdicom 0.28.2) | `extra/`, `cases-extra.json` |
| Expected values | [web/checks/sop-sweep/expect.py](../../web/checks/sop-sweep/expect.py) (pydicom) | `expect.json` |
| Shares | [web/checks/sop-sweep-fixtures.ts](../../web/checks/sop-sweep-fixtures.ts) (`pack-share.ts`, as the Share page packs) | `shares.json` |
| Viewer checks | [web/checks/sop-sweep-checks.mjs](../../web/checks/sop-sweep-checks.mjs), with the reformat oracle [mpr-oracle.py](../../web/checks/sop-sweep/mpr-oracle.py) (SimpleITK) | `results.json`, `shots/` |
| Tables below | [sopclass_report.py](../scripts/sources/sopclass_report.py) | |

### Selection

For each SOP class:
- **Number of series:** 3 by default; 8 for CT and MR, 5 for PET, SEG and SC. Every class gets at least one.
- **Spread:** series are taken in turn from each manufacturer, then each collection, starting with a series near the median size.
- **Size caps:** 150 MB per series; 120 MB for slides and breast projection images.
- **CT, MR and PET volumes:** 20 to 400 instances. One oblique series is picked from `volume_geometry_index`.
- **SEG:** both segmentation types present in IDC, BINARY and FRACTIONAL. IDC has no LABELMAP-type Segmentation; label maps come as the separate Label Map Segmentation class.
- **SEG, RTSTRUCT and annotations:** only where the referenced series is also small.

Picked deliberately:
- four PET series, one CT and one MR whose rescale differs between slices;
- a random control of 20 series under 250 MB.

A case is the picked series plus every series it references that IDC has, up to 400 MB. References come from:
- Referenced Series items;
- SR evidence;
- a segmentation's or structure set's images;
- a registration's series.

The Enhanced CT and MR cases are five public test files (in `~/.cache/shl-quirks`):
- NEMA CT0070 and MOVEKNEE (fo-dicom test data);
- Orthanc's `Issue22.dcm`;
- fo-dicom's `GH1876.dcm`;
- one file attached to fo-dicom issue 2150.

The Legacy Converted cases convert four IDC series with highdicom:
- a CT, twice: frames in spatial order, and frames shuffled with no dimension index;
- the oblique MR;
- a PET whose 212 slices each have their own rescale.

### Checks by category

Categories come from the SOP class, not from the viewer.

| Category | Classes | Checked |
|---|---|---|
| Volume | CT, MR, PET (classic, Enhanced, Legacy Converted), NM, RT Dose | See the list after this table. |
| Multi-frame 2D | US Multi-frame, XA, RF, Multi-frame SC, Breast Tomosynthesis, Breast Projection | The same image checks, and the frames play: the play bar's frame counter moves. A series of several multi-frame instances has one slice per instance, and each instance plays its frames. |
| 2D image | CR, DX, MG, SC, US | Opens, dimensions, values, not blank. |
| SEG, RTSTRUCT | Segmentation, Label Map Segmentation, RT Structure Set | Choosing it opens the referenced images with the layer on. Checked on the three images with the most segment frames or contours (details after this table). The legend lists the segments or structures. |
| Presentation state | GSPS, Advanced Blending | Opens one of its referenced images with its window, or says the object is not displayed. |
| Documents | Enhanced, Comprehensive, Comprehensive 3D, Acquisition Context and Dose SR; KO; STL | Every content item and image reference is shown (SR); key image count (KO); triangles drawn (STL). |
| Slides and annotations | Whole Slide Microscopy, Bulk Simple Annotations | The slide viewer opens with the base level's size and the level count; annotations open their slide with the layer on. |
| Anything else | Raw Data, RT Plan, Spatial Registration, Real World Value Mapping | Shown as an object, named, with "This viewer does not display this kind of object" and a download. |

Volume checks:
- It opens and draws, with one slice per instance, or one per frame of a single multi-frame instance.
- Dimensions are right, and the image is not blank.
- The initial window is the stored window of the slice shown.
- Values under the cursor, at 5 pixels on 3 slices, equal pydicom's stored value × that slice's own rescale.
- In a regular volume, stepping through up to 30 slices visits them in spatial order: by position along the normal, from each frame's Plane Position.
- A multi-frame instance gets a cine control.
- Reformats are checked in the two planes not acquired, plus one oblique (turned 20°, tilted 15°). They use the CPU path and are compared with SimpleITK on the viewer's own plane grid, within one stored unit.
- A series that is not one regular volume must say why it can't be reformatted.

SEG and RTSTRUCT checks, on each of the three images:
- the number of segment frames or contours drawn;
- the bounding box of the drawn pixels, in image pixels, must be within 4 pixels of the mask's or contour's. The expected box comes from plane position.

Every case also fails on any uncaught page error or console error. Screenshots of every primary series, and of every failure, are in `shots/`.

## Coverage by SOP class

Cases are counted under the SOP class of the series they were picked for. Two rows fail because of a series they refer to, not because of the class itself:
- The 5 failing Enhanced SR cases are NLST measurement reports. Each SR displays correctly; the TotalSegmentator segmentation it refers to is drawn upside down (defect 4).
- The failing Comprehensive SR case displays correctly; the presentation state in its study is defect 5.

| SOP class | In IDC v25 (instances / series) | Sampled | Pass | Fail | Unsupported |
|---|--:|--:|--:|--:|--:|
| CT Image | 32,267,458 / 269,895 | 15 (6 control) | 15 | 0 | 0 |
| MR Image | 15,257,538 / 126,452 | 10 (1 control) | 10 | 0 | 0 |
| Raw Data | 7,973,350 / 1,400 | 2 | 0 | 0 | 2 |
| Positron Emission Tomography Image | 1,914,820 / 5,885 | 9 | 6 | 3 | 0 |
| VL Whole Slide Microscopy Image | 391,939 / 76,300 | 3 | 3 | 0 | 0 |
| Secondary Capture Image | 321,318 / 10,941 | 5 | 5 | 0 | 0 |
| Enhanced SR | 262,883 / 262,883 | 7 (4 control) | 2 | 5 | 0 |
| Segmentation | 216,097 / 193,154 | 10 (6 control) | 7 | 3 | 0 |
| Digital Mammography X-Ray - For Processing | 83,191 / 7,979 | 4 (1 control) | 4 | 0 | 0 |
| Breast Tomosynthesis Image | 26,649 / 26,294 | 3 | 3 | 0 | 0 |
| RT Structure Set | 19,366 / 19,366 | 3 | 3 | 0 | 0 |
| Computed Radiography Image | 12,539 / 12,531 | 3 | 3 | 0 | 0 |
| Digital Mammography X-Ray - For Presentation | 7,699 / 3,904 | 3 | 3 | 0 | 0 |
| Microscopy Bulk Simple Annotations | 7,448 / 7,448 | 2 | 2 | 0 | 0 |
| Comprehensive 3D SR | 5,408 / 5,408 | 3 | 3 | 0 | 0 |
| Digital X-Ray - For Presentation | 4,109 / 3,703 | 4 (1 control) | 4 | 0 | 0 |
| Ultrasound Multi-frame Image | 2,762 / 1,887 | 3 | 3 | 0 | 0 |
| Encapsulated STL | 2,328 / 2,328 | 3 | 3 | 0 | 0 |
| Comprehensive SR | 2,118 / 2,118 | 4 (1 control) | 3 | 1 | 0 |
| Ultrasound Image | 1,353 / 81 | 3 | 3 | 0 | 0 |
| Grayscale Softcopy Presentation State | 1,086 / 1,086 | 3 | 0 | 3 | 0 |
| Parametric Map | 691 / 691 | 3 | 3 | 0 | 0 |
| RT Dose | 524 / 524 | 2 | 2 | 0 | 0 |
| RT Plan | 484 / 484 | 3 | 0 | 0 | 3 |
| Advanced Blending Presentation State | 324 / 107 | 3 | 0 | 0 | 3 |
| Multi-frame Grayscale Byte Secondary Capture Image | 320 / 320 | 2 | 2 | 0 | 0 |
| Acquisition Context SR | 277 / 277 | 3 | 3 | 0 | 0 |
| Breast Projection X-Ray - For Processing | 209 / 209 | 2 | 0 | 2 | 0 |
| Breast Projection X-Ray - For Presentation | 204 / 204 | 2 | 2 | 0 | 0 |
| Label Map Segmentation | 129 / 129 | 3 | 0 | 3 | 0 |
| Nuclear Medicine Image | 115 / 95 | 4 | 4 | 0 | 0 |
| Spatial Registration | 97 / 97 | 3 | 0 | 0 | 3 |
| X-Ray Angiographic Image | 48 / 39 | 3 | 3 | 0 | 0 |
| Key Object Selection Document | 40 / 40 | 3 | 3 | 0 | 0 |
| X-Ray Radiofluoroscopic Image | 22 / 12 | 2 | 2 | 0 | 0 |
| Real World Value Mapping | 20 / 20 | 3 | 0 | 0 | 3 |
| Digital X-Ray - For Processing | 11 / 11 | 3 | 3 | 0 | 0 |
| X-Ray Radiation Dose SR | 1 / 1 | 1 | 1 | 0 | 0 |
| Enhanced CT Image | absent | 1 | 1 | 0 | 0 |
| Enhanced MR Image | absent | 4 | 4 | 0 | 0 |
| Legacy Converted Enhanced CT Image | absent | 2 | 1 | 1 | 0 |
| Legacy Converted Enhanced MR Image | absent | 1 | 1 | 0 | 0 |
| Legacy Converted Enhanced PET Image | absent | 1 | 0 | 1 | 0 |
| **All** | | **156** | **120** | **22** | **14** |

## Failures, triaged

Each defect has a regression fixture in [web/checks/sop-sweep/fixtures.json](../../web/checks/sop-sweep/fixtures.json). The fixtures are named by IDC UID and fetched (and, for derived ones, rebuilt) at test time. The commands are at the end of this page. All seven reproduce on that set: 7 of 7 fail.

### 1. Reformats of a series whose rescale differs between slices

- **Seen in:** `pt-lungpetctdx-31900378` (Siemens), `pt-cptacpda-77108044` and `pt-qinpetphantom-41748796` (Siemens phantom). In sagittal, coronal and oblique planes the maximum difference from SimpleITK is 155–205 grey levels, and 12–65% of pixels differ by more than 2. Each slice on its own is right: values under the cursor matched pydicom on all 9 PET cases.
- **Scale in IDC:** 3,941 of 5,885 PET series (67%) have a Rescale Slope or Intercept that differs between instances. So do 1,439 CT and 135 MR series. Every per-slice-rescale series in this sweep that formed a regular volume was PET; the CT and MR ones were not evenly spaced, so the viewer declined to reformat them, with the reason.
- **Likely cause:** `buildVolume` and `makeVolume` in `web/core/volume.ts` stack each slice's stored values. `reformat`/`sampleInto` then interpolate stored values across slices, and `finishPlane` labels the result with `vol.slices[0]`'s rescale. Interpolating between two slices with different slopes mixes incompatible units. The GPU path (`web/core/volume-gl.ts`) works from the same volume. Float slices already go through `sharedRange`/`floatFrame` to one common scale; integer slices with differing rescales need the same treatment.
- **Owner:** viewer core/geometry.
- **Fixture:** `sweep-pet-rescale-mpr` (IDC qin_pet_phantom, 81 instances, 4.8 MB).

### 2. Per-frame rescale and window in functional groups collapse onto frame 1

- **Seen in:** `lce-pt`, a Legacy Converted Enhanced PET with 212 frames, each with its own Pixel Value Transformation. Frame 1 is right. On frames 110 and 212, values under the cursor (and so the displayed image) use frame 1's slope: for example 705.7 instead of 746.9.
- **Likely cause:** `Walker::items` in `codecs/shl-dicom-decode-wasm/src/lib.rs`. It gives each item of a sequence inside a per-frame item the context `Ctx::PerFrame(index)`, where `index` is the nested item's number (always 0), instead of keeping the frame's number. So every Pixel Value Transformation and Frame VOI LUT item is recorded as frame 0's. Run on the file, the decoder returns `perFrame` with 1 entry instead of 212, and `frameOf` (`viewer-kit/src/types.ts`) falls back to the image-level value. This affects every multi-frame object whose rescale or window differs between frames, such as Enhanced and Legacy Converted CT, MR and PET. The existing `enhanced-mf` samples did not show it because they keep these values in the shared groups.
- **Owner:** decoders.
- **Fixture:** `sweep-lce-pt-perframe` (rebuilt from IDC rider_lung_pet_ct with highdicom).

### 3. Frames stored out of spatial order step in stored order

- **Seen in:** `lce-ct-shuffled`, a Legacy Converted Enhanced CT whose 146 frames are stored in a shuffled order with no dimension index. This is valid: Plane Position (Patient) places each frame. The slice slider visits positions 74, 173, 191, −55, … mm. Reformats of the same file match SimpleITK exactly, because `buildVolume` sorts by position. The same series with spatially sorted frames (`lce-ct`) passes.
- **Likely cause:** `sliceTarget` and `draw` in `web/view/view.ts` map slice *i* of a single multi-frame instance to frame *i*. Ordering frames by the per-frame Plane Position along the normal, as classic series are ordered and as `buildVolume` already does, would fix it. Real Enhanced MR is often stored in stack, phase or b-value order, which makes the same mistake visible on scanner data.
- **Owner:** viewer core/geometry.
- **Fixture:** `sweep-lce-ct-shuffled` (rebuilt from IDC nlst CT, 64 frames).

### 4. Segmentations stored in a different orientation from their image

- **Seen in:** all 8 NLST TotalSegmentator segmentations in the sample. Three were picked as SEG (random control); five are referenced by picked Enhanced SR measurement reports. Each SEG has Plane Orientation `[1,0,0, 0,−1,0]`, with Image Position at the image's last row. Its CT has `[1,0,0, 0,1,0]`. The viewer draws the masks upside down: the drawn box's rows are the expected ones mirrored about the image's middle, and the columns match.
- **Scale in IDC:** 138,665 of IDC's 216,097 Segmentation instances store their column direction towards −y; 127,968 of them are NLST. Any of these drawn on an image stored the usual way (column direction +y) comes out upside down.
- **Likely cause:** `Layers.drawSeg` in `web/view/layers.ts` picks the frames for an image correctly, by source reference or position. It then stretches the frame's pixel grid over the image (`g.drawImage(off2, m.x(0), m.y(0), m.cols * m.s, m.rows * m.s)`), ignoring the frame's own Plane Orientation, Plane Position and Pixel Spacing. A SEG on a different grid (cropped, resampled, flipped) lands wrongly. The frame's geometry is already read (`web/core/derived.ts`); drawing needs the affine from SEG pixels to image pixels. The same stretch is used for 60xx overlays, where it is correct.
- **Owner:** objects.
- **Fixture:** `sweep-seg-flipped` (IDC nlst: SR, SEG and CT, 77 MB).

### 5. A presentation state opens its series at the wrong image

- **Seen in:** all 3 GSPS cases (qiba_ct_1c: Philips, GE, Siemens), and the GSPS in `sr-comp-riderlungct-39302`. Each GSPS names one image of a CT with 270 to 365 slices. Choosing it opens the CT at whichever slice the series opens on, with the state's window applied. The named image is elsewhere. The window and inversion are applied to any image of the series, named or not.
- **Likely cause:** `showDerived` in `web/view/view.ts` calls `selectSeries` on the first referenced series and then `applyPresentationState`, but never shows a referenced image. `applyPresentationState` applies the VOI regardless of whether the image on screen is referenced.
- **Owner:** objects.
- **Fixture:** `sweep-gsps-ref-image` (IDC qiba_ct_1c, GE, 159 MB).

### 6. Deflated label-map segmentations are dropped when sharing

- **Seen in:** all 3 Label Map Segmentation cases (tcga_kich, tcga_kirc, tcga_kirp; QIICR). They use the Deflated Explicit VR Little Endian transfer syntax, and the Share page's reader skips them with "no Study or Series Instance UID". The share holds only the CT, and the viewer never sees the segmentation.
- **Likely cause:** `readDicomHeader` in `web/core/dicom-header.ts`, used by `Collection.add` (`web/share/lib/ingest.ts`). It calls `parseDicomSync` without inflating the data set, so a deflated data set reads as empty. The async `parseDicom` (`web/core/dicom.ts`) inflates. Whether the viewer then draws a label map has not been tested, because no share could carry one.
- **Owner:** Share ingest / core parser.
- **Fixture:** `sweep-seg-labelmap-deflated` (IDC tcga_kirp, 52 MB).

### 7. Breast Projection For Processing draws black

- **Seen in:** both Breast Projection X-Ray For Processing cases (Hologic, ea1141). The only window in the file is in the Frame VOI LUT functional group: W 500, L 350. The stored values are around 5,400, with MONOCHROME1 and Presentation LUT Shape INVERSE. The viewer applies that window, and every pixel is black. DCMTK's `dcm2img` finds no window in the file (it does not read the functional group) and shows the image.
- **Likely cause:** the initial window choice in `displayPlan` (`web/core/display.ts`) takes the stored window even when it covers none of the frame's values. A data-range fallback, at least for For Processing images, would avoid a silent black image. The two For Presentation cases (also Hologic, ea1141) pass.
- **Owner:** display.
- **Fixture:** `sweep-bpx-proc-blank` (IDC ea1141, 102 MB).

### Not counted as defects

- **Transient timeouts.** In the final run, three cases timed out loading under machine load: `cr-varepopapollo-31101134`, `mg-cmbbrca-67871841` and `mg-cmmd-28085286`. In the first run, the renderer process crashed once during an axial reformat of `ct-cmbbrca-78056616` (512×593×137, sagittal acquisition). All four pass on rerun, and the table counts the rerun.
- **Per-slice stored windows.** Enhanced CT0070, Orthanc Issue22 and qin_breast_02 MR store a different window for different slices. The viewer opens with the window of the slice shown, and keeps it while stepping. For the two Enhanced files, defect 2 alone would also give one window for every frame.
- **Parametric Maps of slides.** The tcga_gbm maps (Gevaert lab, converted by IDC) are on slide coordinates. They open as a standalone image with correct values, not as a layer over the slide.
- **Advanced Blending Presentation State** is listed as an object the viewer does not display, with a download.

## Object types IDC does not contain

These have no instance in IDC v25, so this sweep says nothing about them. "Elsewhere" names the existing check suites that cover a type from other public sources.

| Object type | In IDC | Elsewhere |
|---|---|---|
| Enhanced CT, Enhanced MR | No (6 Enhanced MR up to v10, now gone) | Here, from public test corpora; `objects/samples.json` `enhanced-mf` |
| Enhanced PET | No (52 up to v10, now gone) | – |
| Legacy Converted Enhanced CT, MR, PET | No | Here, derived with highdicom |
| Enhanced MR Colour, MR Spectroscopy | No | MR Spectroscopy: `other-nonimage` (listed, not displayed) |
| Enhanced US Volume (3D/4D echo) | No | – |
| Enhanced XA / XRF, X-Ray 3D Angiographic and Craniofacial, XA bi-plane | No | – |
| Intravascular OCT; ophthalmic photography, OCT, visual fields | No | – |
| Intra-oral X-ray | No | – |
| Video (endoscopic, microscopic, photographic) and VL endoscopic or photographic stills | No | `video-checks.mjs` (synthetic and public-corpus video) |
| Encapsulated PDF, Encapsulated CDA | No | PDF: `objects` `pdf`; CDA: no public sample found |
| Waveforms: 12-lead and general ECG, haemodynamic, audio, EEG | No | 12-lead ECG and haemodynamic: `objects` `waveform-ecg` |
| Colour, pseudo-colour and (classic) blending presentation states; XA/XRF GSPS | No | – |
| Basic Text SR; Mammography, Chest and Colon CAD SR; Radiopharmaceutical, Patient and Enhanced X-Ray Radiation Dose SR | No | Basic Text SR: `objects` `sr-basic-or-enhanced` |
| RT Image, RT Ion Plan, RT treatment records | No | – |
| Deformable Spatial Registration | No (206 up to v10, now gone) | – |
| Spatial Fiducials, Surface Segmentation, Tractography | No | – |
| Multi-frame True Colour and Word Secondary Capture | No | – |
| Media storage directory (DICOMDIR) | Not stored in IDC | Share page reader (separate checks) |

## Every case

Case ids: `ctl-` marks the random control, `enh-` the public Enhanced files, `lce-` the derived Legacy Converted files. The rest are `<class>-<collection>-<series UID tail>`.


| Case | SOP class | Manufacturer / collection | Why picked | Verdict | Failed checks |
|---|---|---|---|---|---|
| `ct-pelvicreferenc-15876087` | CT Image | Philips / MIM Software / pelvic_reference_data | regular volume, spread by manufacturer then collection | pass |  |
| `ct-adrenalaccki67-38690223` | CT Image | Unknown manufacturer / adrenal_acc_ki67_seg | regular volume, spread by manufacturer then collection | pass |  |
| `ct-tcgablca-97903044` | CT Image | PNMS / tcga_blca | regular volume, spread by manufacturer then collection | pass |  |
| `ct-cmbbrca-78056616` | CT Image | Siemens Healthineers / cmb_brca | regular volume, spread by manufacturer then collection | pass |  |
| `ct-nlmvisiblehuma-9426545` | CT Image | GE Medical Systems / nlm_visible_human_project | regular volume, spread by manufacturer then collection | pass |  |
| `ct-cmbbrca-03175659` | CT Image | Riverain Technologies / cmb_brca | regular volume, spread by manufacturer then collection | pass |  |
| `ct-acrinnsclcfdgp-66732140` | CT Image | McKesson Medical Imaging Group / acrin_nsclc_fdg_pet | regular volume, spread by manufacturer then collection | pass |  |
| `ct-acrinnsclcfdgp-14780064` | CT Image | TOSHIBA / acrin_nsclc_fdg_pet | extra volume | pass |  |
| `mr-nlmvisiblehuma-9426545` | MR Image | GE Medical Systems / nlm_visible_human_project | regular volume, spread by manufacturer then collection | pass |  |
| `mr-cmbbrca-26846284` | MR Image | Hitachi Medical Corporation / cmb_brca | regular volume, spread by manufacturer then collection | pass |  |
| `mr-acrincontralat-99414226` | MR Image | Confirma Inc. / acrin_contralateral_breast_mr | regular volume, spread by manufacturer then collection | pass |  |
| `mr-softtissuesarc-94411285` | MR Image | Varian Medical Systems / soft_tissue_sarcoma | regular volume, spread by manufacturer then collection | pass |  |
| `mr-tcgakirc-04703666` | MR Image | TOSHIBA_MEC / tcga_kirc | regular volume, spread by manufacturer then collection | pass |  |
| `mr-cmbbrca-69741927` | MR Image | Merge Healthcare / cmb_brca | regular volume, spread by manufacturer then collection | pass |  |
| `mr-ispy2-31994547` | MR Image | 0000000 / ispy2 | regular volume, spread by manufacturer then collection | pass |  |
| `mr-cmblca-33194796` | MR Image | SIEMENS HEALTHINEERS / cmb_lca | extra volume | pass |  |
| `raw-pdmr292921168r-8729431` | Raw Data | Philips Medical Systems / pdmr_292921_168_r | spread by manufacturer then collection | unsupported |  |
| `raw-pdmr425362245t-8849011` | Raw Data | Philips Medical Systems / pdmr_425362_245_t | spread by manufacturer then collection | unsupported |  |
| `pt-acrinnsclcfdgp-22070041` | Positron Emission Tomography Image | Philips Medical Systems / MIMvista / acrin_nsclc_fdg_pet | regular volume, spread by manufacturer then collection | pass |  |
| `pt-cmbpca-79404675` | Positron Emission Tomography Image | UIH / MIM Software / cmb_pca | regular volume, spread by manufacturer then collection | pass |  |
| `pt-eay131-53768194` | Positron Emission Tomography Image | SIEMENS / MIM Software / eay131 | regular volume, spread by manufacturer then collection | pass |  |
| `pt-acrinfltbreast-83832069` | Positron Emission Tomography Image | CPS / acrin_flt_breast | regular volume, spread by manufacturer then collection | pass |  |
| `pt-eay131-30664496` | Positron Emission Tomography Image | Philips / eay131 | extra volume | pass |  |
| `sm-cgciblgsp-064940` | VL Whole Slide Microscopy Image | PixelMed / cgci_blgsp | spread by manufacturer then collection | pass |  |
| `sm-ccdimci-999640` | VL Whole Slide Microscopy Image | Leica Biosystems / ccdi_mci | spread by manufacturer then collection | pass |  |
| `sm-tcgacoad-145520` | VL Whole Slide Microscopy Image | Carl Zeiss / tcga_coad | spread by manufacturer then collection | pass |  |
| `sc-cmbcrc-36928361` | Secondary Capture Image | Bayer HealthCare LLC / cmb_crc | spread by manufacturer then collection | pass |  |
| `sc-acrinnsclcfdgp-14277138` | Secondary Capture Image | Siemens / acrin_nsclc_fdg_pet | spread by manufacturer then collection | pass |  |
| `sc-cmbcrc-02534022` | Secondary Capture Image | Hitachi, Ltd. / cmb_crc | spread by manufacturer then collection | pass |  |
| `sc-upenngbm-32967909` | Secondary Capture Image | Siemens HealthCare GmbH / upenn_gbm | spread by manufacturer then collection | pass |  |
| `sc-cptacpda-31573818` | Secondary Capture Image | GE Healthcare / cptac_pda | spread by manufacturer then collection | pass |  |
| `sr-enh-lidcidri-9788709` | Enhanced SR | QIICR / lidc_idri | spread by manufacturer then collection | pass |  |
| `sr-enh-nlst-0694435` | Enhanced SR | QIICR / nlst | spread by manufacturer then collection | fail | seg: lands on the referenced images, in the right place: image 117: drawn over x 4–510, y 58–419; expected x 4–510, y 92–453; image 85: drawn over x 9–505, y 42–439; expected x 9–505, y 72–469; ima |
| `sr-enh-nsclcradiomics-7594271` | Enhanced SR | QIICR / nsclc_radiomics | spread by manufacturer then collection | pass |  |
| `seg-lidcidri-2595429` | Segmentation | 3D Slicer Community / lidc_idri | SegmentationType BINARY | pass |  |
| `seg-tcgaacc-39257090` | Segmentation | Stony Brook University converted by Imaging Data Commons / tcga_acc | SegmentationType BINARY | pass |  |
| `seg-tcgablca-95777724` | Segmentation | Stony Brook University / tcga_blca | SegmentationType BINARY | pass |  |
| `seg-acrin6698-07337032` | Segmentation | Philips Medical Systems / acrin_6698 | SegmentationType FRACTIONAL | pass |  |
| `mg-proc-ea1141-09723069` | Digital Mammography X-Ray - For Processing | GE MEDICAL SYSTEMS / ea1141 | spread by manufacturer then collection | pass |  |
| `mg-proc-ea1141-17026302` | Digital Mammography X-Ray - For Processing | GE HEALTHCARE / ea1141 | spread by manufacturer then collection | pass |  |
| `mg-proc-ea1141-08943953` | Digital Mammography X-Ray - For Processing | HOLOGIC, Inc. / ea1141 | spread by manufacturer then collection | pass |  |
| `bto-ea1141-97152058` | Breast Tomosynthesis Image | GE MEDICAL SYSTEMS / ea1141 | spread by manufacturer then collection | pass |  |
| `bto-ea1141-32572726` | Breast Tomosynthesis Image | GE HEALTHCARE / ea1141 | spread by manufacturer then collection | pass |  |
| `bto-breastcancersc-26665380` | Breast Tomosynthesis Image | HOLOGIC, Inc. / breast_cancer_screening_dbt | spread by manufacturer then collection | pass |  |
| `rtstruct-nsclcradiomics-06118319` | RT Structure Set | Varian Medical Systems / nsclc_radiomics | spread by manufacturer then collection | pass |  |
| `rtstruct-cctumorheterog-37609927` | RT Structure Set | MIM Software Inc. / cc_tumor_heterogeneity | spread by manufacturer then collection | pass |  |
| `rtstruct-mridir-33247200` | RT Structure Set | Velocity Medical Solutions LLC / mri_dir | spread by manufacturer then collection | pass |  |
| `cr-acrinnsclcfdgp-62067128` | Computed Radiography Image | Philips Medical Systems / acrin_nsclc_fdg_pet | spread by manufacturer then collection | pass |  |
| `cr-varepopapollo-76945582` | Computed Radiography Image | Samsung Electronics / varepop_apollo | spread by manufacturer then collection | pass |  |
| `cr-varepopapollo-31101134` | Computed Radiography Image | KONICA MINOLTA / varepop_apollo | spread by manufacturer then collection | pass |  |
| `mg-cmbbrca-67871841` | Digital Mammography X-Ray - For Presentation | GE MEDICAL SYSTEMS / cmb_brca | spread by manufacturer then collection | pass |  |
| `mg-cmmd-28085286` | Digital Mammography X-Ray - For Presentation | (none) / cmmd | spread by manufacturer then collection | pass |  |
| `mg-breastdiagnosi-24485484` | Digital Mammography X-Ray - For Presentation | LORAD / breast_diagnosis | spread by manufacturer then collection | pass |  |
| `ann-tcgablca-85311141` | Microscopy Bulk Simple Annotations | Stony Brook University / tcga_blca | spread by manufacturer then collection | pass |  |
| `ann-tcgabrca-03729357` | Microscopy Bulk Simple Annotations | Stony Brook University / tcga_brca | spread by manufacturer then collection | pass |  |
| `sr-3d-nlst-47623911` | Comprehensive 3D SR | IDC / nlst | spread by manufacturer then collection | pass |  |
| `sr-3d-lungpetctdx-06623778` | Comprehensive 3D SR | Expert annotation from TCIA / lung_pet_ct_dx | spread by manufacturer then collection | pass |  |
| `sr-3d-nlst-29250644` | Comprehensive 3D SR | Sybil / nlst | spread by manufacturer then collection | pass |  |
| `dx-covid19ar-99543819` | Digital X-Ray - For Presentation | KONICA MINOLTA / covid_19_ar | spread by manufacturer then collection | pass |  |
| `dx-covid19nysbu-37360561` | Digital X-Ray - For Presentation | Carestream / covid_19_ny_sbu | spread by manufacturer then collection | pass |  |
| `dx-midrcricord1c-39941322` | Digital X-Ray - For Presentation | (none) / midrc_ricord_1c | spread by manufacturer then collection | pass |  |
| `us-mf-prostatemriusb-42404217` | Ultrasound Multi-frame Image | Eigen / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `us-mf-prostatemriusb-36749274` | Ultrasound Multi-frame Image | Eigen / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `us-mf-prostatemriusb-98851959` | Ultrasound Multi-frame Image | Eigen / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `stl-prostatemriusb-227030` | Encapsulated STL | PixelMed / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `stl-prostatemriusb-629430` | Encapsulated STL | PixelMed / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `stl-prostatemriusb-262830` | Encapsulated STL | PixelMed / prostate_mri_us_biopsy | spread by manufacturer then collection | pass |  |
| `sr-comp-breastdiagnosi-5054916` | Comprehensive SR | PixelMed / breast_diagnosis | spread by manufacturer then collection | pass |  |
| `sr-comp-riderlungct-39302` | Comprehensive SR | CoreLab Partners, Inc. / rider_lung_ct | spread by manufacturer then collection | fail | pr: shows one of its referenced images: 1.3.6.1.4.1.9328.50.1.241902347638712980354326621576796500378 |
| `sr-comp-qibact1c-4887513` | Comprehensive SR | Siemens Corporate Research / qiba_ct_1c | spread by manufacturer then collection | pass |  |
| `us-cptacucec-30139567` | Ultrasound Image | ACUSON / cptac_ucec | spread by manufacturer then collection | pass |  |
| `us-cmbcrc-71789930` | Ultrasound Image | GE Healthcare / cmb_crc | spread by manufacturer then collection | pass |  |
| `us-cmbcrc-28130965` | Ultrasound Image | SIEMENS / cmb_crc | spread by manufacturer then collection | pass |  |
| `gsps-qibact1c-6622553` | Grayscale Softcopy Presentation State | Philips / qiba_ct_1c | spread by manufacturer then collection | fail | pr: shows one of its referenced images: 1.2.840.113704.1.111.2704.1298394462.4332 |
| `gsps-qibact1c-2281288` | Grayscale Softcopy Presentation State | GE MEDICAL SYSTEMS / qiba_ct_1c | spread by manufacturer then collection | fail | pr: shows one of its referenced images: 1.2.840.113619.2.267.3.346830868.413.1298911367.360.151 |
| `gsps-qibact1c-9573760` | Grayscale Softcopy Presentation State | SIEMENS / qiba_ct_1c | spread by manufacturer then collection | fail | pr: shows one of its referenced images: 1.3.12.2.1107.5.1.4.54023.30000011021002131895300004319 |
| `pmap-tcgagbm-07022275` | Parametric Map | Gevaert Lab Converted By Imaging Data Commons / tcga_gbm | spread by manufacturer then collection | pass |  |
| `pmap-tcgagbm-57913162` | Parametric Map | Gevaert Lab Converted By Imaging Data Commons / tcga_gbm | spread by manufacturer then collection | pass |  |
| `pmap-tcgagbm-80579657` | Parametric Map | Gevaert Lab Converted By Imaging Data Commons / tcga_gbm | spread by manufacturer then collection | pass |  |
| `rtdose-pancreaticctcb-13206602` | RT Dose | Varian Medical Systems / pancreatic_ct_cbct_seg | spread by manufacturer then collection | pass |  |
| `rtdose-vestibularschw-28672073` | RT Dose | Elekta / vestibular_schwannoma_seg | spread by manufacturer then collection | pass |  |
| `rtplan-vestibularschw-61089024` | RT Plan | Elekta / vestibular_schwannoma_seg | spread by manufacturer then collection | unsupported |  |
| `rtplan-vestibularschw-45991646` | RT Plan | Elekta / vestibular_schwannoma_seg | spread by manufacturer then collection | unsupported |  |
| `rtplan-vestibularschw-59855798` | RT Plan | Elekta / vestibular_schwannoma_seg | spread by manufacturer then collection | unsupported |  |
| `abps-htanhms-46423415` | Advanced Blending Presentation State | Herrmann Lab / htan_hms | spread by manufacturer then collection | unsupported |  |
| `abps-htanohsu-80889243` | Advanced Blending Presentation State | Herrmann Lab / htan_ohsu | spread by manufacturer then collection | unsupported |  |
| `abps-htantnpsardana-01526195` | Advanced Blending Presentation State | Herrmann Lab / htan_tnp_sardana | spread by manufacturer then collection | unsupported |  |
| `sc-mf8-remind-55678604` | Multi-frame Grayscale Byte Secondary Capture Image | PixelMed / remind | spread by manufacturer then collection | pass |  |
| `sc-mf8-remind-93505942` | Multi-frame Grayscale Byte Secondary Capture Image | PixelMed / remind | spread by manufacturer then collection | pass |  |
| `sr-acq-pdmr292921168r-1731311` | Acquisition Context SR | PixelMed / pdmr_292921_168_r | spread by manufacturer then collection | pass |  |
| `sr-acq-pdmr425362245t-1731328` | Acquisition Context SR | PixelMed / pdmr_425362_245_t | spread by manufacturer then collection | pass |  |
| `sr-acq-pdmr521955158r-691382` | Acquisition Context SR | PixelMed / pdmr_521955_158_r4 | spread by manufacturer then collection | pass |  |
| `bpx-proc-ea1141-36958137` | Breast Projection X-Ray - For Processing | HOLOGIC, Inc. / ea1141 | spread by manufacturer then collection | fail | mf2d: not blank: every pixel drawn at grey 0 |
| `bpx-proc-ea1141-49205776` | Breast Projection X-Ray - For Processing | HOLOGIC, Inc. / ea1141 | spread by manufacturer then collection | fail | mf2d: not blank: every pixel drawn at grey 0 |
| `bpx-ea1141-76347378` | Breast Projection X-Ray - For Presentation | HOLOGIC, Inc. / ea1141 | spread by manufacturer then collection | pass |  |
| `bpx-ea1141-25561849` | Breast Projection X-Ray - For Presentation | HOLOGIC, Inc. / ea1141 | spread by manufacturer then collection | pass |  |
| `seg-lm-tcgakich-0625726` | Label Map Segmentation | QIICR / tcga_kich | spread by manufacturer then collection | fail | every series listed: 1.2.276.0.7230010.3.1.3.0.57354.1787705520.625726 (seg) not in the series list |
| `seg-lm-tcgakirc-0675846` | Label Map Segmentation | QIICR / tcga_kirc | spread by manufacturer then collection | fail | every series listed: 1.2.276.0.7230010.3.1.3.0.61894.1787705960.675846 (seg) not in the series list |
| `seg-lm-tcgakirp-3446926` | Label Map Segmentation | QIICR / tcga_kirp | spread by manufacturer then collection | fail | every series listed: 1.2.276.0.7230010.3.1.3.0.63917.1787706133.446926 (seg) not in the series list |
| `nm-covid19nysbu-40745902` | Nuclear Medicine Image | SIEMENS / covid_19_ny_sbu | spread by manufacturer then collection | pass |  |
| `nm-acrinnsclcfdgp-10550766` | Nuclear Medicine Image | SIEMENS NM / acrin_nsclc_fdg_pet | spread by manufacturer then collection | pass |  |
| `nm-cmbcrc-19302818` | Nuclear Medicine Image | GE MEDICAL SYSTEMS / cmb_crc | spread by manufacturer then collection | pass |  |
| `nm-acrinnsclcfdgp-17602575` | Nuclear Medicine Image | GE MEDICAL SYSTEMS, NUCLEAR / acrin_nsclc_fdg_pet | spread by manufacturer then collection | pass |  |
| `reg-cctumorheterog-14290773` | Spatial Registration | MIM Software Inc. / cc_tumor_heterogeneity | spread by manufacturer then collection | unsupported |  |
| `reg-cctumorheterog-15534602` | Spatial Registration | MIM Software Inc. / cc_tumor_heterogeneity | spread by manufacturer then collection | unsupported |  |
| `reg-cctumorheterog-87708221` | Spatial Registration | MIM Software Inc. / cc_tumor_heterogeneity | spread by manufacturer then collection | unsupported |  |
| `xa-eay131-33229751` | X-Ray Angiographic Image | SIEMENS / eay131 | spread by manufacturer then collection | pass |  |
| `xa-cmbcrc-49503373` | X-Ray Angiographic Image | GE Healthcare Surgery / cmb_crc | spread by manufacturer then collection | pass |  |
| `xa-cmbaml-64960051` | X-Ray Angiographic Image | Siemens / cmb_aml | spread by manufacturer then collection | pass |  |
| `ko-qinbreastdcemr-321822` | Key Object Selection Document | (none) / qin_breast_dce_mri | spread by manufacturer then collection | pass |  |
| `ko-qinbreastdcemr-112912` | Key Object Selection Document | (none) / qin_breast_dce_mri | spread by manufacturer then collection | pass |  |
| `ko-qinbreastdcemr-701611` | Key Object Selection Document | (none) / qin_breast_dce_mri | spread by manufacturer then collection | pass |  |
| `rf-varepopapollo-58660013` | X-Ray Radiofluoroscopic Image | SIEMENS / varepop_apollo | spread by manufacturer then collection | pass |  |
| `rf-cmbpca-20772315` | X-Ray Radiofluoroscopic Image | GEMS / cmb_pca | spread by manufacturer then collection | pass |  |
| `rwv-ctvspetventila-84273003` | Real World Value Mapping | https://github.com/QIICR/Slicer-SUVFactorCalculator / ct_vs_pet_ventilation_imaging | spread by manufacturer then collection | unsupported |  |
| `rwv-ctvspetventila-80390454` | Real World Value Mapping | https://github.com/QIICR/Slicer-SUVFactorCalculator / ct_vs_pet_ventilation_imaging | spread by manufacturer then collection | unsupported |  |
| `rwv-ctvspetventila-92463910` | Real World Value Mapping | https://github.com/QIICR/Slicer-SUVFactorCalculator / ct_vs_pet_ventilation_imaging | spread by manufacturer then collection | unsupported |  |
| `dx-proc-cmbcrc-85887354` | Digital X-Ray - For Processing | FUJIFILM Corporation / cmb_crc | spread by manufacturer then collection | pass |  |
| `dx-proc-cmblca-95416433` | Digital X-Ray - For Processing | FUJIFILM Corporation / cmb_lca | spread by manufacturer then collection | pass |  |
| `dx-proc-cmbmml-27164829` | Digital X-Ray - For Processing | FUJIFILM Corporation / cmb_mml | spread by manufacturer then collection | pass |  |
| `sr-dose-covid19nysbu-12172614` | X-Ray Radiation Dose SR | GE Medical Systems / covid_19_ny_sbu | spread by manufacturer then collection | pass |  |
| `pt-riderlungpetct-92515305` | Positron Emission Tomography Image | (none) / rider_lung_pet_ct | rescale differs between slices | pass |  |
| `pt-lungpetctdx-31900378` | Positron Emission Tomography Image | SIEMENS / lung_pet_ct_dx | rescale differs between slices | fail | volume: reformat sagittal: matches SimpleITK: max /Δ/ 172, mean 15.256, >2: 23.84% (200×100; rescale differs between slices)<br>volume: reformat coronal: matches SimpleITK: max /Δ/ 172, mean 19.256, >2: 38.09% (200×100; rescale differs between slices)<br>volume: reformat sagittal turned 20° tilted 15°: matches SimpleITK: max /Δ/ 172, mean 7.314, >2: 12.21% (256×163; rescale differs between slices) |
| `pt-cptacpda-77108044` | Positron Emission Tomography Image | (none) / cptac_pda | rescale differs between slices | fail | volume: reformat sagittal: matches SimpleITK: max /Δ/ 157, mean 23.164, >2: 65.11% (192×74; rescale differs between slices)<br>volume: reformat coronal: matches SimpleITK: max /Δ/ 158, mean 24.647, >2: 50.77% (192×74; rescale differs between slices)<br>volume: reformat sagittal turned 20° tilted 15°: matches SimpleITK: max /Δ/ 155, mean 10.064, >2: 25.53% (245×135; rescale differs between slices) |
| `pt-qinpetphantom-41748796` | Positron Emission Tomography Image | Siemens / qin_pet_phantom | rescale differs between slices | fail | volume: reformat sagittal: matches SimpleITK: max /Δ/ 205, mean 40.341, >2: 41.33% (168×48; rescale differs between slices)<br>volume: reformat coronal: matches SimpleITK: max /Δ/ 205, mean 59.749, >2: 53.27% (168×48; rescale differs between slices)<br>volume: reformat sagittal turned 20° tilted 15°: matches SimpleITK: max /Δ/ 204, mean 16.929, >2: 16.52% (215×102; rescale differs between slices) |
| `ct-eay131-06933214` | CT Image | GE MEDICAL SYSTEMS / eay131 | rescale differs between slices | pass |  |
| `mr-qinbreast02-81731882` | MR Image | Philips Medical Systems / qin_breast_02 | rescale differs between slices | pass |  |
| `ctl-seg-breastmrinactp-63968482` | Segmentation | GE MEDICAL SYSTEMS / breast_mri_nact_pilot | random control | pass |  |
| `ctl-seg-tcgabrca-87701297` | Segmentation | Stony Brook University converted by Imaging Data Commons / tcga_brca | random control | pass |  |
| `ctl-sr-enh-nlst-2460800` | Enhanced SR | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 103: drawn over x 259–366, y 198–354; expected x 259–366, y 158–314; image 102: drawn over x 259–371, y 196–370; expected x 259–371, y |
| `ctl-sr-enh-nlst-3718107` | Enhanced SR | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 71: drawn over x 9–466, y 54–386; expected x 9–466, y 125–457; image 70: drawn over x 9–468, y 54–386; expected x 9–468, y 125–457; im |
| `ctl-ct-nlst-45747500` | CT Image | GE MEDICAL SYSTEMS / nlst | random control | pass |  |
| `ctl-ct-nlst-51960998` | CT Image | Philips / nlst | random control | pass |  |
| `ctl-mr-acrin6698-52904547` | MR Image | GE MEDICAL SYSTEMS / acrin_6698 | random control | pass |  |
| `ctl-ct-nlst-47287898` | CT Image | SIEMENS / nlst | random control | pass |  |
| `ctl-mg-proc-victre-39900867` | Digital Mammography X-Ray - For Processing | VICTRE / victre | random control | pass |  |
| `ctl-ct-4dlung-63666417` | CT Image | Varian Imaging Laboratories, Switzerland / 4d_lung | random control | pass |  |
| `ctl-sr-enh-nlst-1499366` | Enhanced SR | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 95: drawn over x 40–478, y 98–425; expected x 40–478, y 87–414; image 82: drawn over x 49–468, y 98–423; expected x 49–468, y 89–414;  |
| `ctl-ct-nlst-15419314` | CT Image | GE MEDICAL SYSTEMS / nlst | random control | pass |  |
| `ctl-sr-comp-ispy1-5491108` | Comprehensive SR | PixelMed / ispy1 | random control | pass |  |
| `ctl-ct-nlst-53939148` | CT Image | SIEMENS / nlst | random control | pass |  |
| `ctl-seg-nlst-6788071` | Segmentation | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 73: drawn over x 32–486, y 81–389; expected x 31–485, y 122–430; image 72: drawn over x 32–486, y 81–391; expected x 31–485, y 120–430 |
| `ctl-seg-nlst-0476566` | Segmentation | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 90: drawn over x 49–466, y 85–414; expected x 49–466, y 98–427; image 89: drawn over x 51–466, y 85–414; expected x 51–466, y 98–427;  |
| `ctl-seg-tcgaskcm-43518315` | Segmentation | Stony Brook University converted by Imaging Data Commons / tcga_skcm | random control | pass |  |
| `ctl-sr-enh-nlst-8627878` | Enhanced SR | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 10: drawn over x 29–472, y 101–428; expected x 28–471, y 83–410; image 6: drawn over x 43–466, y 106–425; expected x 42–465, y 86–405; |
| `ctl-dx-covid19nysbu-34673034` | Digital X-Ray - For Presentation | Carestream / covid_19_ny_sbu | random control | pass |  |
| `ctl-seg-nlst-6594249` | Segmentation | QIICR / nlst | random control | fail | seg: lands on the referenced images, in the right place: image 85: drawn over x 0–441, y 94–429; expected x -0–441, y 82–417 |
| `enh-ct-nema-ct0070` | Enhanced CT Image | Acme Medical Devices / (public test corpus) | Enhanced class absent from IDC: public test corpus | pass |  |
| `enh-mr-fodicom-moveknee` | Enhanced MR Image | Acme Medical Devices / (public test corpus) | Enhanced class absent from IDC: public test corpus | pass |  |
| `enh-mr-orthanc-issue22` | Enhanced MR Image | Philips Medical Systems / (public test corpus) | Enhanced class absent from IDC: public test corpus | pass |  |
| `enh-mr-fodicom-gh1876` | Enhanced MR Image | Philips / (public test corpus) | Enhanced class absent from IDC: public test corpus | pass |  |
| `enh-mr-fodicom-2150` | Enhanced MR Image | Philips Medical Systems / (public test corpus) | Enhanced class absent from IDC: public test corpus | pass |  |
| `lce-ct` | Legacy Converted Enhanced CT Image | Philips / MIM Software / pelvic_reference_data | Legacy Converted Enhanced, absent from IDC: derived | pass |  |
| `lce-ct-shuffled` | Legacy Converted Enhanced CT Image | Philips / MIM Software / pelvic_reference_data | Legacy Converted Enhanced, absent from IDC: derived | fail | volume: slices step in spatial order (by position along the normal): positions in viewer order: 74.0, 173.0, 191.0, -55.0, 197.0, 185.0, 224.0, -46.0, -193.0, 155.0, 146.0, 104.0 … |
| `lce-mr` | Legacy Converted Enhanced MR Image | GE Medical Systems / nlm_visible_human_project | Legacy Converted Enhanced, absent from IDC: derived | pass |  |
| `lce-pt` | Legacy Converted Enhanced PET Image | (none) / rider_lung_pet_ct | Legacy Converted Enhanced, absent from IDC: derived | fail | volume: values under the cursor are the stored values through each slice's own rescale: 2 wrong: slice 110 (frame 110) (64,64): 705.7131739854842 vs 746.8775024414086 (stored 9432 × 0.079185485839844 + 0); slice 212 (frame 212)  |

## How to rerun

The full sweep (port 3471 is the sweep's own server; any free port works):

```
cd codec-corpus
uv run python scripts/sources/longtail_bq.py prevalence/sql/sopclass_census.sql /media/barracuda/sop-sweep/bq/census.json
uv run python scripts/sources/longtail_bq.py prevalence/sql/sopclass_rescale_varies.sql /media/barracuda/sop-sweep/bq/rescale.json
uv run --with idc-index python scripts/sources/sopclass_select.py /media/barracuda/sop-sweep/bq/census.json /media/barracuda/sop-sweep/selection.json --rescale /media/barracuda/sop-sweep/bq/rescale.json
uv run --with idc-index --with pydicom python scripts/sources/sopclass_fetch.py /media/barracuda/sop-sweep/selection.json /media/barracuda/sop-sweep
uv run --with highdicom --with pydicom python scripts/sources/sopclass_extra.py /media/barracuda/sop-sweep
cd ..
uv run --project codec-corpus python -I web/checks/sop-sweep/expect.py /media/barracuda/sop-sweep
bun web/checks/sop-sweep-fixtures.ts http://localhost:3471 /media/barracuda/sop-sweep
BASE=http://localhost:3471 node web/checks/sop-sweep-checks.mjs
cd codec-corpus && uv run --with pydicom python scripts/sources/sopclass_report.py /media/barracuda/sop-sweep /media/barracuda/sop-sweep/bq/census.json
```

The regression set only (about 400 MB from IDC):

```
cd codec-corpus
uv run --with idc-index --with pydicom --with highdicom python scripts/sources/sopclass_fetch.py --fixtures ../web/checks/sop-sweep/fixtures.json /media/barracuda/sop-sweep-fixtures
cd ..
uv run --project codec-corpus python -I web/checks/sop-sweep/expect.py /media/barracuda/sop-sweep-fixtures
bun web/checks/sop-sweep-fixtures.ts http://localhost:3471 /media/barracuda/sop-sweep-fixtures
SWEEP=/media/barracuda/sop-sweep-fixtures BASE=http://localhost:3471 node web/checks/sop-sweep-checks.mjs
```

Decoding JPEG and JPEG 2000 files with pydicom in `expect.py` and `mpr-oracle.py` needs `--with pylibjpeg --with pylibjpeg-libjpeg --with pylibjpeg-openjpeg`.
