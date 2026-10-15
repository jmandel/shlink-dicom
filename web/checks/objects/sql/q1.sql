SELECT SOPClassUID, Modality, collection_id, license_short_name, COUNT(*) n, MIN(instance_size) minsz, MAX(instance_size) maxsz
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE SOPClassUID NOT IN ('1.2.840.10008.5.1.4.1.1.2','1.2.840.10008.5.1.4.1.1.4','1.2.840.10008.5.1.4.1.1.128','1.2.840.10008.5.1.4.1.1.77.1.6','1.2.840.10008.5.1.4.1.1.1','1.2.840.10008.5.1.4.1.1.1.1','1.2.840.10008.5.1.4.1.1.1.2','1.2.840.10008.5.1.4.1.1.20','1.2.840.10008.5.1.4.1.1.7')
GROUP BY 1,2,3,4 ORDER BY 1, n DESC
