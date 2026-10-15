SELECT collection_id, license_short_name, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, SOPClassUID, Modality, TransferSyntaxUID, instance_size, crdc_series_uuid, crdc_instance_uuid, aws_bucket
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE SOPInstanceUID IN ('1.3.6.1.4.1.14519.5.2.1.2103.7010.109922625270800872567125701106','1.3.6.1.4.1.14519.5.2.1.2103.7010.251351627304146607908358486482','1.3.6.1.4.1.14519.5.2.1.2103.7010.303887093652740382486272270341','1.3.6.1.4.1.14519.5.2.1.2103.7010.560045868102077137485951952224')
UNION ALL
(SELECT collection_id, license_short_name, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, SOPClassUID, Modality, TransferSyntaxUID, instance_size, crdc_series_uuid, crdc_instance_uuid, aws_bucket
FROM `bigquery-public-data.idc_current.dicom_all` WHERE SOPClassUID='1.2.840.10008.5.1.4.1.1.11.1' AND collection_id IN ('qiba_ct_1c','rider_pilot')
QUALIFY ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY instance_size DESC) <= 2)
