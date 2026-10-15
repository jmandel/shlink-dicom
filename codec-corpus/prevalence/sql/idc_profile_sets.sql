-- How many IDC series and studies contain each distinct set of pixel profiles.
-- Output columns match prevalence/*-sets.csv: level, profiles, count.
-- Save the result as prevalence/profiles-idc-sets.csv.
-- Profile key format is defined in scripts/pixprofile.py:
--   ts|photometric|bits_allocated|bits_stored|pixel_representation|samples_per_pixel|planar|single|multi
-- (planar is forced to 0 when samples_per_pixel is 1). Instances without Bits Allocated are skipped.
WITH inst AS (
  SELECT
    StudyInstanceUID AS study,
    SeriesInstanceUID AS series,
    CONCAT(
      IFNULL(TransferSyntaxUID, ''), '|',
      IFNULL(TRIM(PhotometricInterpretation), ''), '|',
      CAST(BitsAllocated AS STRING), '|',
      CAST(IFNULL(BitsStored, 0) AS STRING), '|',
      CAST(IFNULL(PixelRepresentation, 0) AS STRING), '|',
      CAST(IFNULL(SamplesPerPixel, 1) AS STRING), '|',
      CAST(IF(IFNULL(SamplesPerPixel, 1) > 1, IFNULL(PlanarConfiguration, 0), 0) AS STRING), '|',
      IF(SAFE_CAST(NumberOfFrames AS INT64) > 1, 'multi', 'single')
    ) AS profile
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE BitsAllocated IS NOT NULL
),
per_series AS (
  SELECT series, STRING_AGG(DISTINCT profile, ';' ORDER BY profile) AS profiles FROM inst GROUP BY series
),
per_study AS (
  SELECT study, STRING_AGG(DISTINCT profile, ';' ORDER BY profile) AS profiles FROM inst GROUP BY study
)
SELECT 'series' AS level, profiles, COUNT(*) AS count FROM per_series GROUP BY profiles
UNION ALL
SELECT 'study' AS level, profiles, COUNT(*) AS count FROM per_study GROUP BY profiles
ORDER BY level, count DESC
