WITH pr AS (
  SELECT DISTINCT StudyInstanceUID FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE collection_id IN ('rider_lung_ct','rider_pilot','qiba_ct_1c') AND Modality='PR')
SELECT d.collection_id, d.StudyInstanceUID, d.SeriesInstanceUID, d.Modality, ANY_VALUE(d.SeriesDescription) descr, COUNT(*) n, SUM(d.instance_size) sz, ANY_VALUE(d.license_short_name) lic, ANY_VALUE(d.SegmentationType) segtype, ANY_VALUE(d.TransferSyntaxUID) ts
FROM `bigquery-public-data.idc_current.dicom_all` d JOIN pr USING (StudyInstanceUID)
GROUP BY 1,2,3,4
