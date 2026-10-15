SELECT collection_id, license_short_name, SeriesInstanceUID, ANY_VALUE(SeriesDescription) d, ANY_VALUE(BodyPartExamined) bp, COUNT(*) n, SUM(instance_size) sz, ANY_VALUE(SliceThickness) th, COUNT(DISTINCT ImageOrientationPatient[SAFE_OFFSET(0)]) nori, ANY_VALUE(TransferSyntaxUID) ts, ANY_VALUE(`Rows`) r
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE Modality='CT' AND SOPClassUID='1.2.840.10008.5.1.4.1.1.2' AND license_short_name='CC BY 4.0'
GROUP BY 1,2,3 HAVING n BETWEEN 60 AND 150 AND sz < 40e6 AND COUNT(DISTINCT SliceThickness)=1
ORDER BY sz LIMIT 40
