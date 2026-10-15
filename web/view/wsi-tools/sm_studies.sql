-- Per study: slide series with more instances than pyramid levels (channels or focal planes),
-- and studies where a slide sits beside bulk annotations (ANN) and tiled segmentations (SEG).
SELECT collection_id, license_short_name AS license, crdc_study_uuid AS study, crdc_series_uuid AS series, Modality AS modality,
       COUNT(*) AS instances, COUNT(DISTINCT TotalPixelMatrixColumns) AS widths, SUM(instance_size) AS bytes,
       ANY_VALUE(TRIM(PhotometricInterpretation)) AS photometric, ANY_VALUE(SamplesPerPixel) AS spp, ANY_VALUE(BitsAllocated) AS bits,
       ANY_VALUE(aws_bucket) AS bucket
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE license_short_name IN ('CC BY 4.0', 'CC BY 3.0') AND Modality IN ('SM', 'ANN', 'SEG')
  AND (collection_id LIKE 'tcga_%' OR collection_id LIKE 'htan%' OR Modality = 'SM')
GROUP BY 1, 2, 3, 4, 5
