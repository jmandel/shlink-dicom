-- Whole-slide (SM) series with a CC BY license, one row per series: size, levels, syntaxes.
SELECT collection_id, ANY_VALUE(license_short_name) AS license, series_uuid, ANY_VALUE(aws_bucket) AS bucket,
       COUNT(*) AS instances, SUM(instance_size) AS bytes,
       ARRAY_AGG(DISTINCT TransferSyntaxUID) AS syntaxes,
       ARRAY_AGG(DISTINCT IFNULL(DimensionOrganizationType, '-')) AS dimorg,
       COUNTIF(ARRAY_LENGTH(ImageType) > 2 AND ImageType[OFFSET(2)] = 'VOLUME') AS volumes,
       COUNTIF(ARRAY_LENGTH(ImageType) > 2 AND ImageType[OFFSET(2)] = 'LABEL') AS labels,
       COUNTIF(ARRAY_LENGTH(ImageType) > 2 AND ImageType[OFFSET(2)] = 'OVERVIEW') AS overviews,
       COUNTIF(ARRAY_LENGTH(ImageType) > 2 AND ImageType[OFFSET(2)] = 'THUMBNAIL') AS thumbs,
       MAX(SAFE_CAST(TotalPixelMatrixColumns AS INT64)) AS maxcols, MAX(SAFE_CAST(TotalPixelMatrixRows AS INT64)) AS maxrows
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE Modality = 'SM' AND license_short_name IN ('CC BY 4.0', 'CC BY 3.0')
GROUP BY collection_id, series_uuid
HAVING bytes BETWEEN 1000000000 AND 3000000000 AND volumes BETWEEN 4 AND 8
