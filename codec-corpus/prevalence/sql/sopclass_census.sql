-- SOP class census of IDC (prevalence/SOPCLASS_CENSUS.md): one row per SOP Class UID.
-- Run with scripts/sources/longtail_bq.py; about 8 GB processed.
WITH i AS (
  SELECT SOPClassUID AS sop, SeriesInstanceUID AS series, collection_id AS coll,
         IFNULL(NULLIF(TRIM(Manufacturer), ''), '(none)') AS manu, IFNULL(Modality, '(none)') AS modality,
         SAFE_CAST(NumberOfFrames AS INT64) AS nf, instance_size AS size, license_short_name AS lic
  FROM `bigquery-public-data.idc_current.dicom_all`
),
m AS (SELECT sop, ARRAY_AGG(STRUCT(manu AS v, n) ORDER BY n DESC LIMIT 12) AS manufacturers, COUNT(*) AS n_manufacturers
      FROM (SELECT sop, manu, COUNT(*) AS n FROM i GROUP BY sop, manu) GROUP BY sop),
c AS (SELECT sop, ARRAY_AGG(STRUCT(coll AS v, n) ORDER BY n DESC LIMIT 12) AS collections
      FROM (SELECT sop, coll, COUNT(*) AS n FROM i GROUP BY sop, coll) GROUP BY sop),
d AS (SELECT sop, ARRAY_AGG(STRUCT(modality AS v, n) ORDER BY n DESC) AS modalities
      FROM (SELECT sop, modality, COUNT(*) AS n FROM i GROUP BY sop, modality) GROUP BY sop),
l AS (SELECT sop, ARRAY_AGG(STRUCT(lic AS v, n) ORDER BY n DESC) AS licences
      FROM (SELECT sop, lic, COUNT(*) AS n FROM i GROUP BY sop, lic) GROUP BY sop),
a AS (SELECT sop, COUNT(*) AS instances, COUNT(DISTINCT series) AS series, COUNT(DISTINCT coll) AS n_collections,
             COUNTIF(nf > 1) AS multiframe, SUM(size) AS bytes, MAX(nf) AS max_frames
      FROM i GROUP BY sop)
SELECT a.*, m.manufacturers, m.n_manufacturers, c.collections, d.modalities, l.licences
FROM a JOIN m USING (sop) JOIN c USING (sop) JOIN d USING (sop) JOIN l USING (sop)
ORDER BY instances DESC
