SELECT 'plut' k, PresentationLUTShape v, SOPClassUID, Modality, collection_id, license_short_name, COUNT(*) n, MIN(instance_size) minsz, ANY_VALUE(SeriesInstanceUID) s
FROM `bigquery-public-data.idc_current.dicom_all` WHERE PresentationLUTShape='INVERSE' GROUP BY 1,2,3,4,5,6
UNION ALL
SELECT 'voif', VOILUTFunction, SOPClassUID, Modality, collection_id, license_short_name, COUNT(*), MIN(instance_size), ANY_VALUE(SeriesInstanceUID)
FROM `bigquery-public-data.idc_current.dicom_all` WHERE VOILUTFunction IS NOT NULL AND VOILUTFunction NOT IN ('LINEAR','') GROUP BY 1,2,3,4,5,6
UNION ALL
SELECT 'pscal', PixelSpacingCalibrationType, SOPClassUID, Modality, collection_id, license_short_name, COUNT(*), MIN(instance_size), ANY_VALUE(SeriesInstanceUID)
FROM `bigquery-public-data.idc_current.dicom_all` WHERE PixelSpacingCalibrationType IS NOT NULL GROUP BY 1,2,3,4,5,6
UNION ALL
SELECT 'segtype', SegmentationType, SOPClassUID, Modality, collection_id, license_short_name, COUNT(*), MIN(instance_size), ANY_VALUE(SeriesInstanceUID)
FROM `bigquery-public-data.idc_current.dicom_all` WHERE SegmentationType='FRACTIONAL' GROUP BY 1,2,3,4,5,6
