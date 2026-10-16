-- Segmentations by the direction of their columns (Shared Functional Groups Plane Orientation), for
-- the object-type sweep: SEGs whose column cosine runs towards -y ("flipped" against the usual axial CT).
SELECT collection_id, Manufacturer,
       CASE WHEN SAFE_CAST(iop[SAFE_OFFSET(4)] AS FLOAT64) < -0.5 THEN 'col -y'
            WHEN SAFE_CAST(iop[SAFE_OFFSET(4)] AS FLOAT64) > 0.5 THEN 'col +y' ELSE 'other' END AS col_dir,
       COUNT(*) AS n
FROM (
  SELECT collection_id, Manufacturer,
         SharedFunctionalGroupsSequence[SAFE_OFFSET(0)].PlaneOrientationSequence[SAFE_OFFSET(0)].ImageOrientationPatient AS iop
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE SOPClassUID = '1.2.840.10008.5.1.4.1.1.66.4'
)
GROUP BY 1, 2, 3 ORDER BY n DESC
