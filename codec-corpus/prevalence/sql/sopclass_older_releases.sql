-- SOP classes in older IDC releases (SOPCLASS_CENSUS.md, Retired). 13.7 GB processed.
SELECT 2 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v2.dicom_all` GROUP BY SOPClassUID
UNION ALL
SELECT 6 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v6.dicom_all` GROUP BY SOPClassUID
UNION ALL
SELECT 10 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v10.dicom_all` GROUP BY SOPClassUID
UNION ALL
SELECT 14 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v14.dicom_all` GROUP BY SOPClassUID
UNION ALL
SELECT 18 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v18.dicom_all` GROUP BY SOPClassUID
UNION ALL
SELECT 22 AS v, SOPClassUID, COUNT(*) n FROM `bigquery-public-data.idc_v22.dicom_all` GROUP BY SOPClassUID
