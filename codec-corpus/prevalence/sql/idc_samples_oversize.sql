-- Smallest instance of the IDC profiles that have no instance at or under 60 MB.
SELECT TransferSyntaxUID, PhotometricInterpretation, BitsStored, SamplesPerPixel,
       COUNT(*) AS instances, MIN(instance_size) AS min_size,
       MIN(SAFE_CAST(NumberOfFrames AS INT64)) AS min_frames, ARRAY_AGG(DISTINCT Modality) AS modalities
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE BitsAllocated = 16 AND SAFE_CAST(NumberOfFrames AS INT64) > 1
  AND ((TransferSyntaxUID = '1.2.840.10008.1.2.1' AND TRIM(PhotometricInterpretation) = 'MONOCHROME2' AND BitsStored = 10)
    OR (TransferSyntaxUID = '1.2.840.10008.1.2' AND TRIM(PhotometricInterpretation) = 'MONOCHROME1' AND BitsStored = 14)
    OR (TransferSyntaxUID = '1.2.840.10008.1.2' AND TRIM(PhotometricInterpretation) = 'MONOCHROME2' AND BitsStored = 10))
GROUP BY 1, 2, 3, 4
UNION ALL
SELECT TransferSyntaxUID, PhotometricInterpretation, BitsStored, SamplesPerPixel, COUNT(*), MIN(instance_size),
       MIN(SAFE_CAST(NumberOfFrames AS INT64)), ARRAY_AGG(DISTINCT Modality)
FROM `bigquery-public-data.idc_current.dicom_all`
WHERE BitsAllocated = 8 AND SAFE_CAST(NumberOfFrames AS INT64) > 1 AND TransferSyntaxUID = '1.2.840.10008.1.2'
  AND TRIM(PhotometricInterpretation) = 'RGB'
GROUP BY 1, 2, 3, 4
