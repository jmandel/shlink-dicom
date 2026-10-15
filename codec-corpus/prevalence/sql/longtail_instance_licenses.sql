-- Per-instance license for the registered long-tail cases (prevalence/LONGTAIL.md).
SELECT instance_uuid, license_short_name FROM `bigquery-public-data.idc_current.dicom_all`
WHERE instance_uuid IN ('0e074222-55f0-48c8-8fc7-7aff761672a8','5a326fa5-1607-4b98-bbd1-bc284020e648','79467e29-3d17-4749-b306-4ae40f0939f1','7e444936-d61d-46df-9ec1-b493453800a1','86686ebf-d726-4699-adb5-9399322aba7e','7a280d54-e565-47f2-9f5d-386c488b0840')
