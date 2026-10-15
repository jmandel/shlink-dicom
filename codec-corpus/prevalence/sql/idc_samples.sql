-- Candidate instances for the IDC sample set (scripts/sources/idc_fetch.py picks from these).
-- One row per (instance, reason). Reasons:
--   profile   the 5 smallest instances of each pixel profile (multi-frame: fewest frames first),
--             at most one per series
--   encoder   compressed syntaxes: the 3 smallest per transfer syntax x profile x Manufacturer x
--             ManufacturerModelName (collection when Manufacturer is empty), one per series
--   impl      compressed syntaxes: the smallest per transfer syntax x ImplementationVersionName
--   oldest    compressed syntaxes: the 2 instances with the earliest StudyDate per syntax x profile
-- Instances over 60 MB are excluded.
-- To keep the scan small, the query reads series_uuid/instance_uuid/aws_bucket rather than the
-- long URL and UID columns; the download URL is https://<aws_bucket>.s3.amazonaws.com/<series_uuid>/<instance_uuid>.dcm
-- and the SOPInstanceUID is read from the downloaded file.
WITH inst AS (
  SELECT
    series_uuid, instance_uuid, aws_bucket, collection_id, license_short_name,
    Modality, Manufacturer, ManufacturerModelName, ImplementationVersionName,
    StudyDate, instance_size,
    IFNULL(SAFE_CAST(NumberOfFrames AS INT64), 1) AS nframes,
    TransferSyntaxUID AS ts,
    CONCAT(
      IFNULL(TransferSyntaxUID, ''), '|',
      IFNULL(TRIM(PhotometricInterpretation), ''), '|',
      CAST(BitsAllocated AS STRING), '|',
      CAST(IFNULL(BitsStored, 0) AS STRING), '|',
      CAST(IFNULL(PixelRepresentation, 0) AS STRING), '|',
      CAST(IFNULL(SamplesPerPixel, 1) AS STRING), '|',
      CAST(IF(IFNULL(SamplesPerPixel, 1) > 1, IFNULL(PlanarConfiguration, 0), 0) AS STRING), '|',
      IF(SAFE_CAST(NumberOfFrames AS INT64) > 1, 'multi', 'single')
    ) AS profile,
    TransferSyntaxUID NOT IN ('1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2') AS compressed
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE BitsAllocated IS NOT NULL AND instance_size <= 60000000
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY profile, series_uuid
                       ORDER BY nframes, instance_size) AS rk_series,
    ROW_NUMBER() OVER (PARTITION BY ts, profile, IFNULL(NULLIF(TRIM(Manufacturer), ''), CONCAT('collection:', collection_id)),
                                    IFNULL(ManufacturerModelName, ''), series_uuid
                       ORDER BY nframes, instance_size) AS rk_enc_series,
    ROW_NUMBER() OVER (PARTITION BY ts, IFNULL(ImplementationVersionName, '')
                       ORDER BY nframes, instance_size) AS rk_impl,
    ROW_NUMBER() OVER (PARTITION BY ts, profile ORDER BY StudyDate IS NULL, StudyDate, instance_size) AS rk_oldest
  FROM inst
),
p AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY profile
           ORDER BY instance_size > 20000000, nframes, instance_size) AS rk
  FROM ranked WHERE rk_series = 1
),
e AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY ts, profile,
             IFNULL(NULLIF(TRIM(Manufacturer), ''), CONCAT('collection:', collection_id)), IFNULL(ManufacturerModelName, '')
           ORDER BY instance_size > 20000000, nframes, instance_size) AS rk
  FROM ranked WHERE compressed AND rk_enc_series = 1
)
SELECT 'profile' AS reason, * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest, rk) FROM p WHERE rk <= 5
UNION ALL
SELECT 'encoder', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest, rk) FROM e WHERE rk <= 3
UNION ALL
SELECT 'impl', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest) FROM ranked WHERE compressed AND rk_impl = 1
UNION ALL
SELECT 'oldest', * EXCEPT (rk_series, rk_enc_series, rk_impl, rk_oldest) FROM ranked WHERE compressed AND rk_oldest <= 2
