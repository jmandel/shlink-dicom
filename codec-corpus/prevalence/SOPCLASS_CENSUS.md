# SOP class census of IDC

Every SOP class in NCI Imaging Data Commons, release v25 (26 September 2026), counted from `bigquery-public-data.idc_current.dicom_all` with [sql/sopclass_census.sql](sql/sopclass_census.sql) (8.2 GB processed). [SOPCLASS_SWEEP.md](SOPCLASS_SWEEP.md) uses it to choose what to open in the viewer.

## Headline

- **38 SOP classes, 58.8 million instances.** CT and MR make up 81% of instances; Raw Data (Siemens and GE scanner raw files, 8.0 million) is third.
- **No Enhanced or Legacy Converted Enhanced CT, MR or PET.** The viewer's per-frame functional-group geometry (`web/core/geometry.ts`) is still exercised in IDC by the classes built on the same multi-frame modules: Segmentation (193,844 multi-frame instances), Whole Slide Microscopy, Breast Tomosynthesis (26,301), Breast Projection X-Ray, Parametric Map and Label Map Segmentation.
- **Earlier IDC releases held a few Enhanced objects** (counted with [sql/sopclass_older_releases.sql](sql/sopclass_older_releases.sql); see "Retired" below): 52 Enhanced PET (ACRIN-FMISO-Brain), 6 Enhanced MR (ACRIN-DSC-MR-Brain) and 206 Deformable Spatial Registration (Head-Neck-PET-CT). They are gone from v14 on, and their files no longer download from the IDC buckets.
- **Per-slice rescale is the norm for PET:** 3,941 of 5,885 PET series (67%) have a Rescale Slope or Intercept that differs between instances; so do 1,439 CT series (0.5%) and 135 MR series (0.1%) ([sql/sopclass_rescale_varies.sql](sql/sopclass_rescale_varies.sql), 8.0 GB).
- **Multi-frame:** every RT Dose, US Multi-frame, Breast Projection, Label Map Segmentation and Multi-frame Byte SC instance; nearly every Tomosynthesis instance (26,301 of 26,649); most Segmentation (193,844 of 216,097) and Whole Slide (264,923 of 391,939) instances; 7 PET, 97 NM and 7 RF instances; no CT, MR, CR, DX or MG instance.
- **Documents and annotations:** Enhanced SR (262,883, all TID 1500 measurement reports from QIICR), Comprehensive 3D SR (5,408), Comprehensive SR (2,118), Microscopy Bulk Simple Annotations (7,448), Encapsulated STL (2,328), 40 Key Object Selection documents, 1 X-Ray Radiation Dose SR. **No encapsulated PDF or CDA, no waveforms and no video.**

## Every SOP class

Instances and bytes from `dicom_all`; series counted per SOP class (a series holding two classes counts under both). "Multi-frame" counts instances with Number of Frames above 1. Manufacturers are the instance counts of the three commonest values of Manufacturer, with the number of further distinct values.

| SOP class | UID | Instances | Series | Multi-frame instances | Collections | Manufacturers (top) | Modalities | TB |
|---|---|--:|--:|--:|--:|---|---|--:|
| CT Image | `1.2.840.10008.5.1.4.1.1.2` | 32,267,458 | 269,895 | 0 | 100 | GE MEDICAL SYSTEMS (13,819,833), SIEMENS (11,700,047), Philips (3,863,100) +40 | CT, FUSION, SEG, PT … | 17.22 |
| MR Image | `1.2.840.10008.5.1.4.1.1.4` | 15,257,538 | 126,452 | 0 | 73 | GE MEDICAL SYSTEMS (8,176,014), SIEMENS (4,739,834), Philips Medical Systems (1,976,534) +29 | MR | 4.87 |
| Raw Data | `1.2.840.10008.5.1.4.1.1.66` | 7,973,350 | 1,400 | 0 | 9 | SIEMENS (5,895,847), GE (2,076,502), Philips Medical Systems (1,001) | CT, MR | 0.82 |
| Positron Emission Tomography Image | `1.2.840.10008.5.1.4.1.1.128` | 1,914,820 | 5,885 | 7 | 42 | GE MEDICAL SYSTEMS (804,063), SIEMENS (698,438), (none) (177,385) +15 | PT, CT | 0.21 |
| VL Whole Slide Microscopy Image | `1.2.840.10008.5.1.4.1.1.77.1.6` | 391,939 | 76,300 | 264,923 | 73 | Leica Biosystems (376,338), PixelMed (4,409), RareCyte (4,098) +5 | SM | 49.03 |
| Secondary Capture Image | `1.2.840.10008.5.1.4.1.1.7` | 321,318 | 10,941 | 0 | 39 | VICTRE (140,183), GE MEDICAL SYSTEMS (74,489), SIEMENS (71,563) +19 | MG, CT, MR, XC … | 0.89 |
| Enhanced SR | `1.2.840.10008.5.1.4.1.1.88.22` | 262,883 | 262,883 | 0 | 4 | QIICR (262,883) | SR | 0.14 |
| Segmentation | `1.2.840.10008.5.1.4.1.1.66.4` | 216,097 | 193,154 | 193,844 | 70 | QIICR (152,210), Stony Brook University (28,843), Stony Brook University converted by Imaging Data Commons (21,030) +12 | SEG | 19.49 |
| Digital Mammography X-Ray Image - For Processing | `1.2.840.10008.5.1.4.1.1.1.2.1` | 83,191 | 7,979 | 0 | 3 | VICTRE (77,844), GE MEDICAL SYSTEMS (2,068), GE HEALTHCARE (1,767) +2 | MG | 0.79 |
| Breast Tomosynthesis Image | `1.2.840.10008.5.1.4.1.1.13.1.3` | 26,649 | 26,294 | 26,301 | 2 | HOLOGIC, Inc. (25,485), GE MEDICAL SYSTEMS (787), GE HEALTHCARE (377) | MG | 3.91 |
| RT Structure Set | `1.2.840.10008.5.1.4.1.1.481.3` | 19,366 | 19,366 | 0 | 19 | Open Health Imaging Foundation (16,184), Varian Medical Systems (992), ADAC (834) +6 | RTSTRUCT | 0.01 |
| Computed Radiography Image | `1.2.840.10008.5.1.4.1.1.1` | 12,539 | 12,531 | 0 | 12 | CARESTREAM HEALTH (11,516), Agfa (547), (none) (183) +11 | CR | 0.19 |
| Digital Mammography X-Ray Image - For Presentation | `1.2.840.10008.5.1.4.1.1.1.2` | 7,699 | 3,904 | 0 | 6 | (none) (5,206), HOLOGIC, Inc. (1,936), GE MEDICAL SYSTEMS (309) +3 | MG | 0.07 |
| Microscopy Bulk Simple Annotations | `1.2.840.10008.5.1.4.1.1.91.1` | 7,448 | 7,448 | 0 | 16 | Stony Brook University (6,065), University Hospital Erlangen and Fraunhofer MEVIS (1,033), Friedrich-Alexander-Universität converted by IDC (350) | ANN | 1.82 |
| Comprehensive 3D SR | `1.2.840.10008.5.1.4.1.1.88.34` | 5,408 | 5,408 | 0 | 5 | IDC (3,251), Expert annotation from TCIA (1,091), Sybil (970) +1 | SR | 0.00 |
| Digital X-Ray Image - For Presentation | `1.2.840.10008.5.1.4.1.1.1.1` | 4,109 | 3,703 | 0 | 11 | Carestream (2,627), GE MEDICAL SYSTEMS (607), (none) (536) +10 | DX, CR | 0.05 |
| Ultrasound Multi-frame Image | `1.2.840.10008.5.1.4.1.1.3.1` | 2,762 | 1,887 | 2,762 | 5 | Eigen (1,762), GE Healthcare (938), Philips Medical Systems (56) +1 | US | 0.35 |
| Encapsulated STL | `1.2.840.10008.5.1.4.1.1.104.3` | 2,328 | 2,328 | 0 | 1 | PixelMed (2,328) | M3D | 0.00 |
| Comprehensive SR | `1.2.840.10008.5.1.4.1.1.88.33` | 2,118 | 2,118 | 0 | 7 | PixelMed (1,292), Siemens Corporate Research (722), CoreLab Partners, Inc. (104) | SR | 0.00 |
| Ultrasound Image | `1.2.840.10008.5.1.4.1.1.6.1` | 1,353 | 81 | 0 | 10 | GE Healthcare (871), Philips Medical Systems (273), SIEMENS (152) +2 | US | 0.00 |
| Grayscale Softcopy Presentation State | `1.2.840.10008.5.1.4.1.1.11.1` | 1,086 | 1,086 | 0 | 3 | Siemens Corporate Research (520), Philips (252), (none) (104) +3 | PR | 0.00 |
| Parametric Map | `1.2.840.10008.5.1.4.1.1.30` | 691 | 691 | 0 | 1 | Gevaert Lab Converted By Imaging Data Commons (691) | OT | 0.00 |
| RT Dose | `1.2.840.10008.5.1.4.1.1.481.2` | 524 | 524 | 524 | 2 | Elekta (484), Varian Medical Systems (40) | RTDOSE | 0.01 |
| RT Plan | `1.2.840.10008.5.1.4.1.1.481.5` | 484 | 484 | 0 | 1 | Elekta (484) | RTPLAN | 0.00 |
| Advanced Blending Presentation State | `1.2.840.10008.5.1.4.1.1.11.8` | 324 | 107 | 0 | 4 | Herrmann Lab (324) | PR | 0.00 |
| Multi-frame Grayscale Byte Secondary Capture Image | `1.2.840.10008.5.1.4.1.1.7.2` | 320 | 320 | 320 | 1 | PixelMed (320) | US | 0.02 |
| Acquisition Context SR | `1.2.840.10008.5.1.4.1.1.88.71` | 277 | 277 | 0 | 6 | PixelMed (277) | SR | 0.00 |
| Breast Projection X-Ray Image - For Processing | `1.2.840.10008.5.1.4.1.1.13.1.5` | 209 | 209 | 209 | 1 | HOLOGIC, Inc. (209) | MG | 0.02 |
| Breast Projection X-Ray Image - For Presentation | `1.2.840.10008.5.1.4.1.1.13.1.4` | 204 | 204 | 204 | 1 | HOLOGIC, Inc. (204) | MG | 0.02 |
| Label Map Segmentation | `1.2.840.10008.5.1.4.1.1.66.7` | 129 | 129 | 129 | 3 | QIICR (129) | SEG | 0.00 |
| Nuclear Medicine Image | `1.2.840.10008.5.1.4.1.1.20` | 115 | 95 | 97 | 9 | SIEMENS NM (74), GE MEDICAL SYSTEMS (27), Philips Healthcare (6) +4 | NM | 0.00 |
| Spatial Registration | `1.2.840.10008.5.1.4.1.1.66.1` | 97 | 97 | 0 | 1 | MIM Software Inc. (97) | REG | 0.00 |
| X-Ray Angiographic Image | `1.2.840.10008.5.1.4.1.1.12.1` | 48 | 39 | 0 | 4 | Siemens (41), GE Healthcare Surgery (6), SIEMENS (1) | XA | 0.00 |
| Key Object Selection Document | `1.2.840.10008.5.1.4.1.1.88.59` | 40 | 40 | 0 | 1 | (none) (40) | KO | 0.00 |
| X-Ray Radiofluoroscopic Image | `1.2.840.10008.5.1.4.1.1.12.2` | 22 | 12 | 7 | 2 | SIEMENS (11), GEMS (11) | RF | 0.00 |
| Real World Value Mapping | `1.2.840.10008.5.1.4.1.1.67` | 20 | 20 | 0 | 1 | https://github.com/QIICR/Slicer-SUVFactorCalculator (20) | RWV | 0.00 |
| Digital X-Ray Image - For Processing | `1.2.840.10008.5.1.4.1.1.1.1.1` | 11 | 11 | 0 | 3 | FUJIFILM Corporation (11) | DX | 0.00 |
| X-Ray Radiation Dose SR | `1.2.840.10008.5.1.4.1.1.88.67` | 1 | 1 | 0 | 1 | GE Medical Systems (1) | SR | 0.00 |

38 SOP classes; 58,784,975 instances; 1,044,303 series (a series counted once per SOP class it holds).

## Retired

SOP classes present in older IDC releases and absent from v25 (from `idc_v2`, `idc_v6`, `idc_v10`, `idc_v14`, `idc_v18`, `idc_v22`; 13.7 GB processed):

| SOP class | Releases seen | Instances | Collection |
|---|---|--:|---|
| Enhanced PET Image (`1.2.840.10008.5.1.4.1.1.130`) | v2, v6, v10 | 52 | acrin_fmiso_brain |
| Enhanced MR Image (`1.2.840.10008.5.1.4.1.1.4.1`) | v2, v6, v10 | 6 | acrin_dsc_mr_brain |
| Deformable Spatial Registration (`1.2.840.10008.5.1.4.1.1.66.3`) | v2, v6, v10 | 206 | head_neck_pet_ct |

Their v2 `gcs_url`s return 403 from Google Cloud Storage and 404 from the S3 bucket, and `idc-index`'s prior-versions table does not list their series.

## How to rerun

```
cd codec-corpus
uv run python scripts/sources/longtail_bq.py prevalence/sql/sopclass_census.sql census.json
uv run --with pydicom python scripts/sources/sopclass_census.py census.json   # the table above
```
