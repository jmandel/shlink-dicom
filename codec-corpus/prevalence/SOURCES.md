# Prevalence sources

Each source below has a method, a size, known biases, and its most common pixel profiles. The profile key is defined in `scripts/pixprofile.py`. Profiles are written as *syntax, photometric, sign + bits stored / bits allocated, samples per pixel, planar configuration, frames*: for example `u12/16` means unsigned, 12 bits stored in 16 allocated.

No source here measures clinical archives. IDC is measured but is a research archive. The clinical evidence in [section 3](#3-clinical-practice-standards-and-vendor-documentation) is standards text and vendor documentation, not counts. A coverage figure must therefore name its source, for example "decodes 99.9% of IDC image instances", and should not be presented as a clinical figure.

## 1. NCI Imaging Data Commons (IDC), all instances

- **What:** every instance in IDC release v25, read from `bigquery-public-data.idc_current.dicom_all`.
- **Size:** 58,784,975 instances. 58,482,404 of them carry Bits Allocated (have pixel data); the other 302,571 (SR, RTSTRUCT, RTPLAN, annotations and so on) are dropped. The data comes from about 168,500 studies in 179 collections.
- **Method:** one BigQuery query, `sql/idc_profiles.sql`, run on 2026-10-14 (11.9 GB scanned). The raw export is `cache/profiles-idc.csv` (gitignored). `scripts/convert_idc_bq.py` turns it into `profiles-idc.csv`. This is a full count, not a sample.
- **Study-level data:** pending. `sql/idc_profile_sets.sql` produces `profiles-idc-sets.csv`: the number of series and studies containing each distinct set of profiles. A dry run estimates 11.2 GB scanned. Until that file exists, `coverage.py` reports IDC coverage by instance only.
- **Cheaper route, checked and not used:** the `idc-index` pip package has a series-level table with transfer syntax, photometric and pixel representation. It has no bits allocated, bits stored, samples per pixel, planar configuration or frame count, so it cannot give full profiles. Slide microscopy also has a per-instance transfer-syntax table.

### Biases

- **Research data, mostly cancer imaging.** IDC holds data contributed to cancer research collections, most of it via TCIA, after de-identification. By instance: CT is 68.9%, MR 26.2%, PT 3.3%, slide microscopy 0.67%, MG 0.46% and SEG 0.38%. Ultrasound (0.009%), XA (0.001%), endoscopy and ophthalmology are almost absent. Clinical archives hold far more radiography, ultrasound and angiography.
- **Mostly uncompressed.** 99.3% of instances are Explicit (72.2%) or Implicit (27.1%) VR Little Endian. The compressed syntaxes are JPEG Baseline 0.38% (almost all slide microscopy), JPEG 2000 Lossless 0.10%, JPEG 2000 0.07%, JPEG Lossless SV1 0.06%, JPEG Extended 0.05%, JPEG-LS 261 instances and Deflate 129. There is no RLE and no HTJ2K at all. Vendor documentation ([section 3](#3-clinical-practice-standards-and-vendor-documentation)) shows that clinical devices commonly send JPEG Lossless, JPEG Baseline and RLE. So IDC certainly under-represents compression. We have not established how much of this comes from the contributors' own pipelines and how much from TCIA or IDC processing.
- **Counted by instance.** A CT series of 500 slices weighs 500 times as much as one radiograph. Study-level coverage (pending, see above) is the fairer headline.

### Top profiles (instances)

These 24 profiles cover 99.90% of image instances. The full table, by modality, is in `profiles-idc.csv`.

| Profile | Instances | % | Cumulative | Main modalities |
|---|---:|---:|---:|---|
| Explicit VR LE, MONOCHROME2, s16/16, single | 18,181,944 | 31.09 | 31.09 | CT 59%, MR 34%, PT 7% |
| Explicit VR LE, MONOCHROME2, u12/16, single | 17,904,837 | 30.62 | 61.71 | CT 80%, MR 20% |
| Implicit VR LE, MONOCHROME2, u16/16, single | 8,724,095 | 14.92 | 76.62 | CT 93%, MR 4%, MG 3% |
| Explicit VR LE, MONOCHROME2, u16/16, single | 5,507,998 | 9.42 | 86.04 | MR 58%, CT 31%, PT 10% |
| Implicit VR LE, MONOCHROME2, s16/16, single | 5,326,237 | 9.11 | 95.15 | CT 82%, MR 17% |
| Implicit VR LE, MONOCHROME2, u12/16, single | 1,801,860 | 3.08 | 98.23 | CT 50%, MR 50% |
| JPEG Baseline, RGB, u8/8, 3 samples, multi | 198,701 | 0.34 | 98.57 | SM |
| Explicit VR LE, RGB, u8/8, 3 samples planar 0, single | 194,917 | 0.33 | 98.90 | SM 60%, CT 34% (secondary captures) |
| Explicit VR LE, MONOCHROME2, u1/1, multi | 184,474 | 0.32 | 99.22 | SEG |
| Explicit VR LE, PALETTE COLOR, u8/8, single | 72,170 | 0.12 | 99.34 | MR |
| Explicit VR LE, MONOCHROME2, s13/16, single | 62,286 | 0.11 | 99.45 | CT |
| JPEG 2000 Lossless, MONOCHROME2, u12/16, single | 31,993 | 0.05 | 99.50 | MR |
| JPEG Extended, MONOCHROME2, u12/16, single | 26,820 | 0.05 | 99.55 | CT |
| Explicit VR LE, MONOCHROME1, s16/16, single | 25,338 | 0.04 | 99.59 | PT |
| JPEG Lossless SV1, MONOCHROME2, s16/16, single | 24,986 | 0.04 | 99.63 | CT |
| JPEG 2000, YBR_FULL_422, u8/8, 3 samples, multi | 23,729 | 0.04 | 99.68 | SM |
| Explicit VR BE, MONOCHROME2, s16/16, single | 23,166 | 0.04 | 99.71 | CT, MR |
| JPEG 2000 Lossless, MONOCHROME2, u10/16, multi | 22,032 | 0.04 | 99.75 | MG (tomosynthesis) |
| JPEG Baseline, YBR_FULL_422, u8/8, 3 samples, multi | 19,242 | 0.03 | 99.79 | SM |
| Explicit VR LE, MONOCHROME2, u8/8, single | 16,181 | 0.03 | 99.81 | SEG, MG, SM |
| JPEG 2000, YBR_ICT, u8/8, 3 samples, multi | 15,003 | 0.03 | 99.84 | SM |
| Explicit VR LE, MONOCHROME2, u1/1, single | 14,221 | 0.02 | 99.86 | SEG |
| Explicit VR LE, MONOCHROME2, u8/8, multi | 12,880 | 0.02 | 99.88 | SEG, US, SM |
| JPEG Lossless SV1, MONOCHROME2, u12/16, single | 11,310 | 0.02 | 99.90 | CT, MR, DX |

## 2. Local demo studies

- **What:** the two studies in `data/samples/*.tgz`, profiled with `scripts/profile_local.py` into `profiles-local-demo.csv` and `profiles-local-demo-sets.csv`.
- **Size:** 266 image instances, 17 series, 2 studies.
- **Biases:** two studies are an example, not a sample. They are useful as a check that the pipeline runs end to end, and as two real patient-held exports.

| Profile | Instances | Study |
|---|---:|---|
| Explicit VR LE, MONOCHROME2, s16/16, single | 263 (98.9%) | MR brain, 14 series |
| JPEG Extended, MONOCHROME2, u12/16, single | 3 (1.1%) | CR wrist, 3 series |

The wrist study uses 12-bit lossy JPEG (Process 4), which other sources call rare ([section 3](#3-clinical-practice-standards-and-vendor-documentation), item 7). A third of the demo studies depends on it.

## 3. Clinical practice: standards and vendor documentation

We found **no published measurement** of transfer-syntax or pixel-profile frequencies in clinical PACS archives, VNAs or patient CDs. The measured studies below count CD importability or conformance, not encodings. Everything else is standards text, device conformance statements or expert opinion, labelled as such. Conformance statements list what a device *can* send. The site configures what it actually sends, and archives may transcode on arrival.

### Patient media (CD, DVD, USB)

1. **Standard.** DICOM PS3.11 Table D.3-1: the general-purpose CD profile STD-GEN-CD (and its DVD-RAM, BD and -SEC variants) allows only Explicit VR Little Endian. <https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_D.3.html>
2. **Standard.** PS3.11 Annex H: the general-purpose DVD/USB -JPEG profiles make JPEG Lossless SV1 (.70), JPEG Baseline (.50) and JPEG Extended (.51) mandatory; the -J2K profiles make JPEG 2000 (.90, .91) mandatory. <https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_H.3.html>
3. **Standard (IHE).** The IHE PDI Extensions supplement (2009) keeps STD-GEN-CD as the baseline. Its DVD/USB options let the creator choose uncompressed, JPEG lossy (8 or 12 bit), JPEG lossless (up to 16 bit) or JPEG 2000. Readers must decode all of them. It says compressed CDs "are commonly used for cardiac angiography and for cine ultrasound", and that the RLE syntax "used by some US devices is not supported". <https://www.ihe.net/Technical_Framework/upload/IHE-RAD_TF_Suppl_PDI_Extensions_2009-06-21.pdf>
4. **Standard.** Modality media profiles. STD-CTMR readers must support Explicit VR LE and JPEG Lossless SV1. STD-US creators may use Explicit VR LE, RLE or JPEG Baseline, and readers must support all three. <https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_E.3.html>, <https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_C.3.html>
5. **Measured (importability, not encoding).**
   - Sodickson et al., *Radiology* 2011: outside CDs for emergency transfers imported into PACS successfully in 78% of cases (1,161 of 1,487). <https://pubmed.ncbi.nlm.nih.gov/21507903/>
   - DRG CD tests (2006): 74% of 65 CDs from 27 vendors violated the specifications. "Incorrect transfer syntax" was one of the error types, with no breakdown given. <https://www.auntminnie.com/imaging-informatics/enterprise-imaging/pacs-vna/article/15580782/testing-procedure-improves-usability-of-dicom-cds>

### What is commonly used (expert opinion)

6. **Anecdotal.** Clunie (2009), under "What is currently mostly used?":
   - "Lossless JPEG CT and MR MODs";
   - "Lossless JPEG XA CDs and network";
   - "Lossy JPEG Ultrasound media and network";
   - "Lossless RLE Ultrasound (occasionally)";
   - "Lossless JPEG in long term archives".

   Of the JPEG processes, "only one DICOM process common – Lossless 16 bit Selection Value 1 Huffman". <https://www.dclunie.com/papers/MIIT_2009_DicomCompression_Clunie.pdf>
7. **Anecdotal.** The author of dcm2nii: JPEG baseline and lossless are "common in DICOM"; 12-bit lossy JPEG is "exceptionally rare"; JPEG-LS is "rare". <https://crnl.readthedocs.io/jpeg_formats/index.html>
8. **Anecdotal.** DICOM WG-04 (2023): JPEG 2000 "has seen low adoption". <https://www.dicomstandard.org/news-dir/progress/docs/sups/sup235-slides.pdf>
9. **Anecdotal.** RSNA Screening Mammography challenge data (about 20,000 studies from 2 sites): "many of the images use the jpeg 2000 format". No count is given, and the data may have been transcoded. <https://github.com/RSNA/AI-Challenge-Data/wiki/RSNA-Screening-Mammography-Breast-Cancer-Detection>

### Device conformance statements, by modality (vendor-stated)

| Modality | Device | Syntaxes and pixel format offered | Source |
|---|---|---|---|
| US | Philips EPIQ/Affiniti | Uncompressed, JPEG Baseline, JPEG Lossless, RLE. 8-bit; YBR_FULL_422 when compressed; planar 0 | [Philips](https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20220223/5d66604347ff428595f9ae45010fe674.pdf) |
| US | Siemens Acuson Sequoia | Single-frame: RLE, YBR_FULL. Multi-frame: JPEG Baseline, YBR_FULL_422 | [Siemens](https://marketing.webassets.siemens-healthineers.com/5bc673d2ca263e9e/26340d2ac9c9/acuson_sequoia_dcs_v6.0-00835334.pdf) |
| US | Siemens Acuson Maple | Multi-frame: JPEG Baseline or uncompressed; stress echo only as lossy JPEG | [Siemens](https://marketing.webassets.siemens-healthineers.com/a8e0e168c20ab7a7/f0a8fa356e26/ACUSON_Maple_VA10_DICOM_Conformance_Statement.pdf) |
| US | Canon Aplio | JPEG Baseline, JPEG Lossless, RLE, uncompressed; RGB, MONOCHROME2 or YBR_FULL_422; planar 0 or 1 | [Canon](https://www.medical.canon/Interoperability/dicom/2G985-096EN.pdf) |
| US | DICOM CP-1678 | YBR_FULL "has been used only with the RLE Transfer Syntax and only for Ultrasound", with planar configuration 1 | [CP-1678](https://dicom.nema.org/medical/dicom/CP/cp1678_lb_YBR_FULL_JPEG_not_RLE.pdf) |
| MG, DBT | Hologic Dimensions | JPEG Lossless SV1 proposed first, then uncompressed, JPEG-LS, JPEG 2000 Lossless. MG is u14/16 MONOCHROME1 (original) or u12/16 MONOCHROME2 (derived); DBT slices u10/16 | [Hologic](https://hologic.com/sites/default/files/2023-09/Dimensions%20v1.12%20and%203Dimensions%20v2.3%20DICOM%20Conformance%20Statement%20%28RD-04751%29%20English%20Rev_001%2008-2023.pdf) |
| CR | Fujifilm FCR | Implicit/Explicit VR LE, JPEG Lossless SV1 | [Fujifilm](https://healthcaresolutions-us.fujifilm.com/wp-content/uploads/2023/02/FCRView_DICOM_Conformance.pdf) |
| XA | Siemens Artis zee/Q | JPEG Extended, JPEG Lossless SV1, JPEG Baseline, uncompressed. MONOCHROME2; 8 or 16 bits allocated; multi-frame | [Siemens](https://marketing.webassets.siemens-healthineers.com/e3c20cfae6f192aa/edadc8498200/Artis_zee_zeego_Q_Q.zen_VD12_DICOM_Conformance_Statement.pdf) |
| CT | Siemens syngo CT VB20A | u16/16; JPEG Lossless SV1 by default on media | [Siemens](https://marketing.webassets.siemens-healthineers.com/b5d98730cf24baf3/08c6df27daff/CT_Somaris10_VB20A_P60_DICOM_Conformance_Statement.pdf) |
| PT | Siemens Biograph mCT | Compression only for unsigned pixel data | [Siemens](https://marketing.webassets.siemens-healthineers.com/affff06c840aa07b/74fb9a8aeaa1/PET_CT_Biograph_mCT_VG85A_DICOM_Conformance_Statement.PDF) |
| Endoscopy | Hologic Omni 4K | Stills: uncompressed RGB 8-bit. Video: H.264 | [Hologic](https://hologic.com/sites/default/files/2021-04/720-00042%20Rev%20A%20User%20Guide%2C%20DICOM%2C%20Omni%204K%20Video%20System.pdf) |
| SM | Philips Pathology Scanner SGi | Only JPEG Baseline (YBR_FULL_422) and JPEG XL | [Philips](https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20260428/2e216ab9b90d4f19984cb43a009f25d0.pdf) |
| OP/OPT | Zeiss Cirrus OCT | Only JPEG 2000 (irreversible) | [Zeiss](https://aao.org/Assets/fb766ea1-7a4f-4389-9b87-81471b4d9434/637982426733130000/cirrus-hd-oct-6000-5000-500-dicom-conformance-statement-pdf) |
| OP | Zeiss Visucam | JPEG Baseline, JPEG Lossless, uncompressed (the default) | [Zeiss](https://aao.org/Assets/54341f2e-9f00-4347-b7f0-d15c71f406aa/637982426744000000/visucam-224-and-visucam-524-dicom-conformance-statement-pdf) |
| OP | DICOM PS3.3 C.8.17.2 | RGB with uncompressed or lossless; YBR_FULL_422 with lossy JPEG; YBR_ICT/RCT with JPEG 2000 | [PS3.3](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.17.2.html) |

### What viewers decode (vendor-stated)

All of Cornerstone3D/OHIF, Weasis, RadiAnt, MicroDicom and OsiriX decode uncompressed, JPEG Baseline, JPEG Lossless and JPEG 2000. Most also decode RLE and JPEG-LS. Video (MPEG-2, H.264) is usually handed to a system player.

- Cornerstone3D: <https://github.com/cornerstonejs/cornerstone3D/tree/main/packages/dicomImageLoader/src/shared/decoders>
- Weasis: <https://weasis.org/en/basics/dicom/>
- RadiAnt: <https://www.radiantviewer.com/dicom-viewer-manual/radiant_dicom_viewer_features.html>
- MicroDicom: <https://www.microdicom.com/dicom-viewer.html>
- OsiriX: <https://www.osirix-viewer.com/pdf/DICOMConformanceStatements.pdf>

### Profiles clinical sources point to that IDC barely contains

These are the profiles we would expect in patient-held studies, from items 3–6 and the conformance table. They have no measured frequency, so they belong in the corpus regardless of what the IDC numbers say:

- **Ultrasound:**
  - JPEG Baseline, YBR_FULL_422, u8/8, 3 samples, multi-frame (cine);
  - RLE, YBR_FULL, u8/8, 3 samples, planar 1;
  - uncompressed RGB, planar 0 or 1.
- **XA/RF cine:** JPEG Lossless SV1, MONOCHROME2, u8/8 or u12/16, multi-frame.
- **CR/DX/MG:** JPEG Lossless SV1 with MONOCHROME1 u14/16 or u15/16, and u12/16 MONOCHROME2.
- **CT/MR on CD:** JPEG Lossless SV1, s16/16 and u12/16 or u16/16.
- **DBT:** JPEG 2000 Lossless, u10/16, multi-frame.
- **OCT and slide microscopy:** JPEG 2000 YBR_ICT, multi-frame.
- **Endoscopy and video:** MPEG-2 and H.264. These are outside the decoder's scope.

## Using these sources in a claim

- Run `scripts/coverage.py profiles-idc.csv <report>`. Quote the figure as "N% of IDC image instances (or studies), a research archive that is 99.3% uncompressed".
- Add separately which of the clinical profiles listed in [section 3](#profiles-clinical-sources-point-to-that-idc-barely-contains) the corpus covers and passes. They have no measured frequency. Don't add them to a percentage.

## Two real patient exports (owner's own, profiled locally, October 2026)

Two disc/portal exports belonging to the project owner (a head MRI CD with a bundled eFilm Lite viewer, and a CT abdomen/pelvis plus hand/wrist CR set from a second provider) were profiled with `scripts/profile_local.py`. Only aggregate counts were kept (`cache/local/jmandel-cds.csv`, not committed); no files were added to the corpus.

- 737 image instances, 4 studies, 2 providers. Every instance is uncompressed: Implicit VR Little Endian (CT, CR) or Explicit VR Little Endian (MR). This matches the General Purpose CD-R profile (STD-GEN-CD), which allows only uncompressed data.
- Profiles: CT signed 16/16 (456), MR signed 16/16 (267), MR unsigned 16/16 (4), CR MONOCHROME1 unsigned 12/16 (6), CR MONOCHROME2 unsigned 12/16 (3), CT 8-bit (1).
- Our decoder (`shl-dicom-decode`) reproduced pydicom's pixels exactly on all 737.

Two exports are anecdote, not a frequency estimate; they are recorded as a check that the uncompressed-CD expectation holds for at least these providers.
