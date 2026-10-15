# IDC samples

Real files from the NCI Imaging Data Commons (IDC v25), added to the corpus so that every IDC pixel profile has a case with exactly that profile, and so that each compressed syntax has cases from several encoders. Run on 2026-10-14.

All files are de-identified research data under CC BY 3.0, CC BY 4.0 or CC BY-NC 4.0 (per instance, in `cases.json` → `source.license`). They live only in the gitignored `formats/<fmt>/samples/` and `prevalence/cache/idc/` directories. Do not publish them.

## Method

1. **Candidate query.** `sql/idc_samples.sql` over `bigquery-public-data.idc_current.dicom_all`, run through `scripts/sources/idc_bq.py` (BigQuery REST API, billed to `fhir-org-starter-project`, dry run first). For each instance it computes the profile key used by `prevalence/scripts/pixprofile.py` and returns candidates for four reasons:
   - `profile`: the 5 smallest instances per profile, at most one per series, preferring ≤ 20 MB and then fewest frames;
   - `encoder` (compressed syntaxes only): the 3 smallest per syntax × profile × Manufacturer × ManufacturerModelName, one per series; the collection stands in when Manufacturer is empty;
   - `impl` (compressed only): the smallest per syntax × ImplementationVersionName;
   - `oldest` (compressed only): the 2 instances with the earliest StudyDate per syntax × profile.

   Instances over 60 MB are excluded. To keep the scan small, the query reads `series_uuid`, `instance_uuid` and `aws_bucket` instead of the long URL and UID columns. The download URL is `https://<aws_bucket>.s3.amazonaws.com/<series_uuid>/<instance_uuid>.dcm` (public buckets `idc-open-data`, `idc-open-data-two`, `idc-open-data-cr`), and the SOPInstanceUID is read from the downloaded file.
2. **Selection** (`scripts/sources/idc_fetch.py`):
   - uncompressed profiles: the best `profile` candidate, plus the best one from a second collection when there is one;
   - compressed profiles: every candidate.
3. **Download and register.** `idc_fetch.py` downloads over HTTPS into `prevalence/cache/idc/dl/` and registers each file with `discover.register`. Case ids are `idc-<syntax>-<photometric>-<sign bits stored "of" bits allocated>[-p<planar>]-<sf|mf>-<modality>-<manufacturer or collection>-<sha256(SOPInstanceUID)[:8]>`. `source` holds `kind: idc`, collection, SOPInstanceUID, URL, license, manufacturer, model, implementation version, study date, modality, the IDC series/instance UUIDs, and the reasons it was picked. Tags: `idc`, `profile:<profile key>` and `idc-<reason>`. The full pick list is `prevalence/cache/idc/picked.json`.
4. **Oracles.** `scripts/sources/idc_oracle.py` runs `oracle.build` on the `idc-*` cases only, in parallel, and saves only those entries. `oracle.py` writes back every case of the format it loaded. While this ran, another agent's write to `uncompressed/cases.json` replaced the new expectations once, and the uncompressed oracles were rebuilt.

### Queries and bytes scanned

| Query | Purpose | Scanned |
|---|---|---:|
| `sql/idc_samples.sql` | candidates (548 rows, 451 distinct instances) | 14.01 GB |
| `sql/idc_samples_oversize.sql` | smallest instance of the 4 profiles with nothing ≤ 60 MB | 4.08 GB |
| **Total** | | **18.09 GB** |

Dry runs and one schema read (free) came first. An earlier draft of the candidate query that read `SOPInstanceUID`, `SeriesInstanceUID`, `aws_url` and `gcs_url` dry-ran at 29.4 GB and was not run.

The candidate query, as run:

```sql
WITH inst AS (
  SELECT
    series_uuid, instance_uuid, aws_bucket, collection_id, license_short_name,
    Modality, Manufacturer, ManufacturerModelName, ImplementationVersionName,
    StudyDate, instance_size,
    IFNULL(SAFE_CAST(NumberOfFrames AS INT64), 1) AS nframes,
    TransferSyntaxUID AS ts,
    CONCAT(IFNULL(TransferSyntaxUID, ''), '|', IFNULL(TRIM(PhotometricInterpretation), ''), '|',
      CAST(BitsAllocated AS STRING), '|', CAST(IFNULL(BitsStored, 0) AS STRING), '|',
      CAST(IFNULL(PixelRepresentation, 0) AS STRING), '|', CAST(IFNULL(SamplesPerPixel, 1) AS STRING), '|',
      CAST(IF(IFNULL(SamplesPerPixel, 1) > 1, IFNULL(PlanarConfiguration, 0), 0) AS STRING), '|',
      IF(SAFE_CAST(NumberOfFrames AS INT64) > 1, 'multi', 'single')) AS profile,
    TransferSyntaxUID NOT IN ('1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2') AS compressed
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE BitsAllocated IS NOT NULL AND instance_size <= 60000000
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY profile, series_uuid ORDER BY nframes, instance_size) AS rk_series,
    ROW_NUMBER() OVER (PARTITION BY ts, profile,
        IFNULL(NULLIF(TRIM(Manufacturer), ''), CONCAT('collection:', collection_id)),
        IFNULL(ManufacturerModelName, ''), series_uuid ORDER BY nframes, instance_size) AS rk_enc_series,
    ROW_NUMBER() OVER (PARTITION BY ts, IFNULL(ImplementationVersionName, '') ORDER BY nframes, instance_size) AS rk_impl,
    ROW_NUMBER() OVER (PARTITION BY ts, profile ORDER BY StudyDate IS NULL, StudyDate, instance_size) AS rk_oldest
  FROM inst
),
p AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY profile
        ORDER BY instance_size > 20000000, nframes, instance_size) AS rk FROM ranked WHERE rk_series = 1),
e AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY ts, profile,
        IFNULL(NULLIF(TRIM(Manufacturer), ''), CONCAT('collection:', collection_id)), IFNULL(ManufacturerModelName, '')
        ORDER BY instance_size > 20000000, nframes, instance_size) AS rk FROM ranked WHERE compressed AND rk_enc_series = 1)
SELECT 'profile' AS reason, * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest, rk) FROM p WHERE rk <= 5
UNION ALL SELECT 'encoder', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest, rk) FROM e WHERE rk <= 3
UNION ALL SELECT 'impl', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest) FROM ranked WHERE compressed AND rk_impl = 1
UNION ALL SELECT 'oldest', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest) FROM ranked WHERE compressed AND rk_oldest <= 2
```

## What was picked

299 instances, 0.92 GB downloaded, from 64 collections. 296 were registered:

| Format | Cases |
|---|---:|
| jpeg2000 | 82 |
| jpeg-dct | 73 |
| uncompressed | 72 |
| jpeg-lossless | 62 |
| jpeg-ls | 7 |

Licenses: CC BY 4.0 (181), CC BY 3.0 (71), CC BY-NC 4.0 (44).

Three downloads were not registered, because `discover.register` needs a Pixel Data element:
- two Explicit VR LE CT instances of 2–6 KB (GE in `nlst`, Toshiba in `qiba_ct_1c`) that carry no Pixel Data at all. They were picked as the smallest of a profile that already has cases;
- an instance from `tcga_gbm` ("Gevaert Lab Converted By Imaging Data Commons", modality OT, Parametric Map, SOP class 1.2.840.10008.5.1.4.1.1.30): it stores Float Pixel Data, which is outside this decoder's scope. Its profile is "Explicit VR LE, MONOCHROME2, u0/32" (691 IDC instances), and it remains a blind spot.

Four profiles have no instance at or under 60 MB, so they have no case:

| Profile | IDC instances | Smallest instance (fewest frames) | Modality |
|---|---:|---:|---|
| Explicit VR LE, MONOCHROME2, u10/16, multi-frame | 3,444 | 223 MB (24 frames) | MG (tomosynthesis) |
| Implicit VR LE, MONOCHROME1, u14/16, multi-frame | 209 | 79 MB (15 frames) | MG |
| Implicit VR LE, MONOCHROME2, u10/16, multi-frame | 204 | 79 MB (15 frames) | MG |
| Implicit VR LE, RGB, u8/8, multi-frame | 26 | 67 MB (70 frames) | US |

The last three have a relaxed match that passes.

### Encoders in the compressed cases

In IDC the encoder of a compressed file is usually a converter, not the modality: PixelMed `TIFFToDicom` for slide microscopy, dcm4che 1.4.x for transcoded CT/PT, pydicom 3.0.1 for the Mirax JPEG slides, highdicom for the JPEG-LS SEGs and DCMTK (dcmqi) for the deflated SEGs. ImplementationVersionName `0.5` appears on the JPEG 2000 Lossless MR/MG and some JPEG Lossless data. StudyDates such as 1901, 1944 and 1970 are shifted by de-identification.

| Syntax | Manufacturer | Model | Implementation versions | Cases | Passed | Earliest StudyDate |
|---|---|---|---|---:|---:|---|
| Deflate | QIICR | https://github.com/QIICR/dcmqi | OFFIS_DCMTK_370 | 7 | 7 | 1988-06-20 |
| JPEG 2000 | BioImagene | iScan converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 2 | 2 | 2024-02-17 |
| JPEG 2000 | Carl Zeiss | Mirax converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG 2000 | Hamamatsu | NanoZoomer converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG 2000 | Hamamatsu | com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG 2000 | Leica Biosystems | Aperio converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 13 | 6 | 2008-02-18 |
| JPEG 2000 Lossless | GE MEDICAL SYSTEMS | GENESIS_SIGNA | 0.5 | 6 | 6 | 2016-07-27 |
| JPEG 2000 Lossless | HOLOGIC, Inc. | Selenia Dimensions | 0.5 | 6 | 6 | 2000-01-01 |
| JPEG 2000 Lossless | Leica Biosystems | Aperio AT2 converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 8 | 8 | 2022-06-18 |
| JPEG 2000 Lossless | Leica Biosystems | Aperio converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 5 | 4 | 2018-10-05 |
| JPEG 2000 Lossless | Leica Biosystems | SCN400 converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 10 | 10 | 2022-06-18 |
| JPEG 2000 Lossless | RareCyte | converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 6 | 2 | 1970-01-01 |
| JPEG 2000 Lossless | SIEMENS | - | 0.5 | 2 | 2 | 2013-11-17 |
| JPEG 2000 Lossless | SIEMENS | Espree | 0.5 | 2 | 2 | 2013-07-06 |
| JPEG 2000 Lossless | SIEMENS | Skyra_fit | 0.5 | 3 | 3 | 2013-08-06 |
| JPEG 2000 Lossless | SIEMENS | TrioTim | 0.5 | 5 | 5 | 2012-11-07 |
| JPEG 2000 Lossless | SIEMENS | Verio | 0.5 | 2 | 2 | 2013-03-09 |
| JPEG 2000 Lossless | Siemens HealthCare GmbH | MAGNETOM Vida | 0.5 | 3 | 3 | 2013-10-19 |
| JPEG Baseline | BioImagene | iScan converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG Baseline | Carl Zeiss | Mirax converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG Baseline | Hamamatsu | NanoZoomer converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG Baseline | Hamamatsu | com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2024-02-17 |
| JPEG Baseline | Leica Biosystems | Aperio AT2 converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 3 | 3 | 2022-06-18 |
| JPEG Baseline | Leica Biosystems | Aperio converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 5 | 5 | 2007-09-20 |
| JPEG Baseline | Leica Biosystems | GT450 converted by com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 14 | 14 | 2020-08-24 |
| JPEG Baseline | Mirax | Pannoramic 250 | PYDICOM 3.0.1 | 4 | 2 | - |
| JPEG Baseline | Mirax | Pannoramic MIDI | PYDICOM 3.0.1 | 6 | 3 | - |
| JPEG Baseline | PixelMed | com.pixelmed.convert.TIFFToDicom | PIXELMEDJAVA001 | 20 | 20 | 2022-06-20 |
| JPEG Extended | GE MEDICAL SYSTEMS | LightSpeed Ultra | dcm4che-1.4.31 | 6 | 6 | 1999-01-02 |
| JPEG Extended | GE MEDICAL SYSTEMS | LightSpeed16 | dcm4che-1.4.31 | 3 | 3 | 2000-01-02 |
| JPEG Lossless SV1 | (none; midrc_ricord_1a) | - | 0.5 | 3 | 3 | 2004-12-12 |
| JPEG Lossless SV1 | (none; midrc_ricord_1b) | - | 0.5 | 3 | 3 | 2002-07-01 |
| JPEG Lossless SV1 | (none; midrc_ricord_1c) | - | 0.5 | 19 | 19 | 2002-03-12 |
| JPEG Lossless SV1 | Agfa | CR 85 | 0.5 | 13 | 13 | 1999-08-07 |
| JPEG Lossless SV1 | GE MEDICAL SYSTEMS | Discovery 690 | dcm4che-1.4.34 | 1 | 1 | 1993-05-30 |
| JPEG Lossless SV1 | GE MEDICAL SYSTEMS | Discovery RX | dcm4che-1.4.34 | 3 | 3 | 1992-12-01 |
| JPEG Lossless SV1 | Philips | Mx8000 | dcm4che-1.4.31 | 3 | 3 | 2000-01-02 |
| JPEG Lossless SV1 | SIEMENS | SOMATOM Definition AS+ | dcm4che-1.4.34 | 5 | 5 | 1993-08-06 |
| JPEG Lossless SV1 | SIEMENS | SOMATOM Definition Flash | dcm4che-1.4.34 | 3 | 3 | 1993-11-03 |
| JPEG Lossless SV1 | SIEMENS | TrioTim | 0.5 | 4 | 4 | 2011-08-27 |
| JPEG Lossless SV1 | SIEMENS | Verio | 0.5 | 2 | 2 | 2011-10-30 |
| JPEG Lossless SV1 | SIEMENS | Volume Zoom | dcm4che-1.4.31 | 3 | 3 | 2000-01-02 |
| JPEG-LS Lossless | NCI/FNLCR | FNLCR_IVG_RMS_iou_0.7343_0.7175_epoch_60 | highdicom0.23.0 | 7 | 7 | 2018-10-05 |

## Coverage before and after

`prevalence/scripts/coverage.py prevalence/profiles-idc.csv <report>`. The decoder is the one built for this run (`codecs/target/idc`, report `reports/idc.json`). Other agents added 195 `ext-*` cases to the corpus while this ran, and two of them fail on the largest profile, so three views are given:

| View | Instances exact | relaxed | Series exact | relaxed | Studies exact | relaxed |
|---|---:|---:|---:|---:|---:|---:|
| Before, as reported (`reports/coord.json`, earlier decoder build) | 81.26% | 99.83% | 78.15% | 94.89% | 67.24% | 90.74% |
| Before: same decoder, corpus without `idc-*` and `ext-*` cases | 81.31% | 99.95% | 78.16% | 98.47% | 67.26% | 95.47% |
| After: same decoder, corpus with `idc-*`, without `ext-*` | 99.92% | 99.82% | 97.75% | 95.29% | 94.21% | 91.34% |
| After: full report `reports/idc.json` | 69.30% | 28.57% | 72.73% | 46.00% | 62.34% | 32.70% |

IDC profiles by exact-match status (78 profiles):

| | Passing | Failing | No case |
|---|---:|---:|---:|
| Before (same decoder, no `idc-*`/`ext-*`) | 32 | 0 | 46 |
| After (with `idc-*`, no `ext-*`) | 68 | 5 | 5 |

- The 46 → 5 drop in blind spots is the main result. The remaining five are the four profiles with nothing ≤ 60 MB and the float Parametric Map profile.
- The relaxed figures go down after the IDC cases are added. A relaxed group now contains real files that fail (for example, JPEG 2000 Lossless u16 RareCyte slides fail, and that group also covers the u12/16 MR profile), so the old relaxed figure was an over-estimate.
- The full-report row is low because `uncompressed/ext-gdcm-DMCPACS_ExplicitImplicit_BogusIOP` and `ext-gdcm-TheralysGDCM120Bug` fail. Both have the profile "Explicit VR LE, MONOCHROME2, u12/16, single" (30.6% of IDC instances), so that whole profile is marked failing. Those cases belong to another agent and are not IDC files.

## Decoder results on the IDC cases

296 cases: 279 pass, 17 fail, 0 crash, 0 unsupported. No new case is `expect=error`, and no new case is disputed.

### Failures

| Format | Cases | Error | Diagnosis |
|---|---|---|---|
| jpeg-dct | `idc-jpgbase-ybr422-u8of8-p0-mf-sm-mirax-13171271`, `-34afa752`, `-4aa2f077`, `-51acc9ef`, `-6fc896a9` (Mirax Pannoramic 250 / MIDI slides written by pydicom 3.0.1) | `invalid: Extended Offset Table length 24658 exceeds the fragment (24650 bytes)` | The file's Extended Offset Table Lengths are wrong. In `-51acc9ef` the offsets are (0, 24658), the lengths are (24658, 47314) and the fragments are 24650 and 47314 bytes. The first length includes the 8-byte item header; PS3.5 A.4 says it should be the frame's length. Every reference decodes the file, because they ignore the table or fall back to the fragments. The CLI (`shl-dicom-decode`, coordinator-owned) should fall back to fragment boundaries when the Extended Offset Table disagrees with them, instead of refusing. The single-frame Mirax cases pass. |
| jpeg2000 | `idc-j2k-ybr422-u8of8-p0-mf-sm-leicabiosy-13edc3a6`, `-2d25d48c`, `-42e6c13e`, `-808f97ac`, `-99915e22`, `-9d9043df`, `-ee6cf575` (Leica Aperio, PixelMed TIFFToDicom, JPEG 2000 lossy, YBR_FULL_422) | `invalid: subsampled JPEG 2000 components are not allowed in DICOM` | The codestream has 3 components, and components 1 and 2 are subsampled 2×1 (SIZ XRsiz=2, YRsiz=1); there is no MCT and the 9/7 filter is used. The decoder refuses this on conformance grounds. IDC has 23,729 instances of this profile, so it is real data. It needs a ruling, and then component upsampling in the jpeg2000 codec or the CLI. Only pylibjpeg (OpenJPEG) decodes these. The GDCM plugin fails (`'NoneType' object has no attribute 'encode'`), and `openjpeg-cli` fails with `index out of range`, so the oracle rests on one reference. |
| jpeg2000 | `idc-j2kr-mono2-u16of16-sf-sm-rarecyte-53f42619`, `-bf244307`, `idc-j2kr-mono2-u16of16-mf-sm-rarecyte-1e744ed2`, `-33e23936` (RareCyte, PixelMed TIFFToDicom, JPEG 2000 Lossless) | `invalid: JPEG 2000: failed to parse COD marker` | The COD is `ff52 000c 00 00 0021 00 05 04 04 00 01`: LRCP, **33 quality layers**, no MCT, 5 levels, 64×64 code-blocks, 5/3 filter, 16-bit samples. The two RareCyte RGB cases have the same COD with 32 layers and pass. The other IDC J2K files have 1 layer (slides, Hologic) or 10–13 (GE, Siemens MR), and pass. The parser probably caps the layer count at 32; ISO 15444-1 allows up to 65535. Owned by the jpeg2000 agent. |
| jpeg2000 | `idc-j2kr-rct-u8of8-p0-mf-sm-leicabiosy-d680304a` (Leica Aperio, 110 frames, YBR_RCT, lossless) | `max \|diff\| 89 > allowed 0` | Only frame 75 of 110 differs; 47,709 of its 57,600 pixels are off, mostly by 1 (oracle 243,243,242 vs candidate 244,243,243). Its main headers (SIZ, COD, QCD, QCC, COM) are byte-identical to the frames that decode correctly; only the tile length differs. This points to a tier-1 or inverse-transform bug triggered by this tile's data, in the jpeg2000 codec. Frame 75 is a near-white background tile (mean 242). Reproduce with `shl-dicom-decode` on the sample and compare frame 75. |

### Reference decoder notes (not failures)

- **No disputes and no `expect=error`.** All 296 new cases got `expect=decode`.
- **JPEG 2000 oracles are "WEAK".** 58 of 82 jpeg2000 cases have a "WEAK" confidence because `pydicom:gdcm`, `pydicom:pylibjpeg` and `openjpeg-cli` all count as the OpenJPEG family. Where two or three of them ran, they agree exactly.
- **`openjpeg-cli` fails on 30 of the IDC JPEG 2000 cases** with `index out of range`: 25 multi-frame slide files and 5 single-frame MR (Siemens, GE) files. The other references decode them. This looks like a bug in the reference wrapper in `scripts/ref_decode.py`, not in the files.
- **GDCM fails on all 7 subsampled YBR_FULL_422 JPEG 2000 cases** (see above).

## Reproduce

```sh
cd codec-corpus
uv run python scripts/sources/idc_bq.py prevalence/sql/idc_samples.sql prevalence/cache/idc/candidates.json --dry-run
uv run python scripts/sources/idc_bq.py prevalence/sql/idc_samples.sql prevalence/cache/idc/candidates.json
uv run python scripts/sources/idc_fetch.py            # --dry-run lists the picks
uv run python scripts/sources/idc_oracle.py           # oracles for idc-* cases only
```

`idc_bq.py` refuses a query whose dry run is over 15 GB unless `--max-gb` is raised. IDC is updated in place (`idc_current`), so a later run may pick different instances; the instances picked this time are listed in `prevalence/cache/idc/picked.json` and in each case's `source`.
