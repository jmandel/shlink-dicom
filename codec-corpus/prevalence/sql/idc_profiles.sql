-- Pixel-profile counts for every IDC instance (run 2026-10-14, IDC v25, 11.9 GB billed).
-- Raw export: prevalence/cache/profiles-idc.csv (gitignored);
-- converted with scripts/convert_idc_bq.py into prevalence/profiles-idc.csv.
-- series/studies are COUNT(DISTINCT) within each row and cannot be summed across rows;
-- idc_profile_sets.sql gives the per-series and per-study profile sets for that.
SELECT TransferSyntaxUID, Modality, PhotometricInterpretation, BitsAllocated, BitsStored,
       PixelRepresentation, SamplesPerPixel, PlanarConfiguration,
       (SAFE_CAST(NumberOfFrames AS INT64) > 1) AS multiframe,
       COUNT(*) AS instances,
       COUNT(DISTINCT SeriesInstanceUID) AS series,
       COUNT(DISTINCT StudyInstanceUID) AS studies,
       SUM(instance_size) AS bytes
FROM `bigquery-public-data.idc_current.dicom_all`
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
