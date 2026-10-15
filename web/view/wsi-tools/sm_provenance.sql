-- Collection, DOI and license of the slide series used for testing.
SELECT DISTINCT collection_id, series_uuid, source_DOI, license_short_name, license_long_name, license_url
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE series_uuid IN ('29368d94-3a65-4fdc-a796-9b1a48540c67', '5928613e-17d1-4182-84e8-12220d80ca11', '4a6b5ed5-a7e8-450d-9af6-e739b1807bac')
