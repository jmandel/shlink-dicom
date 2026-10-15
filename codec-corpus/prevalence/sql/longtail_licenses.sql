-- License per collection, for registering long-tail cases (prevalence/LONGTAIL.md).
SELECT collection_id, license_short_name, COUNT(*) AS n
FROM `bigquery-public-data.idc_current.dicom_all`
GROUP BY 1, 2
