-- Whole-slide feature census for workstream D: per collection, license and feature, how many
-- series and the smallest one. Features: focal planes > 1, optical paths > 1, TILED_SPARSE,
-- transfer syntax (JPEG XL), and the annotation / segmentation objects that sit beside slides.
SELECT collection_id, license_short_name AS license, Modality AS modality, SOPClassUID AS sop,
       TransferSyntaxUID AS ts, IFNULL(DimensionOrganizationType, '-') AS dimorg,
       SAFE_CAST(TotalPixelMatrixFocalPlanes AS INT64) > 1 AS zstack,
       SAFE_CAST(NumberOfOpticalPaths AS INT64) > 1 AS multipath,
       COUNT(DISTINCT series_uuid) AS series, COUNT(*) AS instances,
       MIN(instance_size) AS min_instance, ANY_VALUE(series_uuid) AS example_series
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE Modality IN ('SM', 'ANN') OR (Modality = 'SEG' AND SOPClassUID = '1.2.840.10008.5.1.4.1.1.66.4' AND DimensionOrganizationType IS NOT NULL)
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
