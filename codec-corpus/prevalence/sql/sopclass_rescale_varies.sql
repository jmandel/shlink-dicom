-- Series whose Rescale Slope or Intercept differs between instances (CT, MR, PET), for the object-type
-- sweep: how common it is, and small examples. About 6 GB processed.
WITH s AS (
  SELECT SOPClassUID AS sop, SeriesInstanceUID AS series, ANY_VALUE(collection_id) AS coll, ANY_VALUE(Manufacturer) AS manu,
         COUNT(*) AS n, COUNT(DISTINCT CONCAT(CAST(RescaleSlope AS STRING), '/', CAST(RescaleIntercept AS STRING))) AS rescales,
         SUM(instance_size) AS bytes
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE SOPClassUID IN ('1.2.840.10008.5.1.4.1.1.2', '1.2.840.10008.5.1.4.1.1.4', '1.2.840.10008.5.1.4.1.1.128')
  GROUP BY 1, 2
)
SELECT 'summary' AS kind, sop, NULL AS series, NULL AS coll, NULL AS manu, COUNT(*) AS n, COUNTIF(rescales > 1) AS rescales, NULL AS bytes FROM s GROUP BY sop
UNION ALL
SELECT 'example', sop, series, coll, manu, n, rescales, bytes FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY sop, manu ORDER BY bytes) AS rk FROM s WHERE rescales > 1 AND n BETWEEN 30 AND 300
) WHERE rk <= 2
