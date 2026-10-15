-- Long-tail sweep candidates (prevalence/LONGTAIL.md). One scan of dicom_all:
--   'freq'  one row per (clue, value): instance count and 3 candidate instances (pseudo-random by
--           FARM_FINGERPRINT, preferring instance_size <= 100 MB)
--   'combo' one row per TS x ImplementationVersionName x Manufacturer x Model x SoftwareVersions
--   'inst'  the full clue vector of every candidate, plus the uniform control sample
--           (MOD(ABS(h), 40000) = 17 over instances with Bits Allocated)
WITH base AS (
  SELECT
    FARM_FINGERPRINT(instance_uuid) AS h,
    series_uuid, instance_uuid, aws_bucket, instance_size,
    IFNULL(TransferSyntaxUID, '(absent)') AS ts,
    IFNULL(SOPClassUID, '(absent)') AS sop_class,
    IFNULL(NULLIF(TRIM(Manufacturer), ''), '(absent)') AS manufacturer,
    IFNULL(NULLIF(TRIM(ManufacturerModelName), ''), '(absent)') AS model,
    IFNULL(NULLIF(ARRAY_TO_STRING(SoftwareVersions, '\\'), ''), '(absent)') AS software,
    IFNULL(ImplementationClassUID, '(absent)') AS impl_class,
    IFNULL(NULLIF(TRIM(ImplementationVersionName), ''), '(absent)') AS impl_ver,
    IFNULL(NULLIF(TRIM(SourceApplicationEntityTitle), ''), '(absent)') AS src_ae,
    IFNULL(ConversionType, '(absent)') AS conversion_type,
    IFNULL(NULLIF(ARRAY_TO_STRING(ImageType, '\\'), ''), '(absent)') AS image_type,
    IFNULL(Modality, '(absent)') AS modality,
    IFNULL(TRIM(PhotometricInterpretation), '(absent)') AS photometric,
    FORMAT('%s/%s/%s/%s', IFNULL(CAST(BitsAllocated AS STRING), '-'), IFNULL(CAST(BitsStored AS STRING), '-'),
           IFNULL(CAST(HighBit AS STRING), '-'), IFNULL(CAST(PixelRepresentation AS STRING), '-')) AS bits,
    CASE WHEN HighBit IS NULL OR BitsStored IS NULL THEN 'absent'
         WHEN HighBit = BitsStored - 1 THEN 'normal' ELSE FORMAT('hb%+d', HighBit - (BitsStored - 1)) END AS high_bit,
    FORMAT('%s/%s', IFNULL(CAST(SamplesPerPixel AS STRING), '-'), IFNULL(CAST(PlanarConfiguration AS STRING), 'absent')) AS spp_planar,
    CASE WHEN NumberOfFrames IS NULL THEN 'absent'
         WHEN SAFE_CAST(NumberOfFrames AS INT64) IS NULL THEN 'unparseable'
         WHEN SAFE_CAST(NumberOfFrames AS INT64) <= 1 THEN CAST(SAFE_CAST(NumberOfFrames AS INT64) AS STRING)
         WHEN SAFE_CAST(NumberOfFrames AS INT64) <= 10 THEN '2-10'
         WHEN SAFE_CAST(NumberOfFrames AS INT64) <= 100 THEN '11-100'
         WHEN SAFE_CAST(NumberOfFrames AS INT64) <= 1000 THEN '101-1000' ELSE '>1000' END AS frames,
    IFNULL(LossyImageCompression, '(absent)') AS lossy,
    IFNULL(NULLIF(ARRAY_TO_STRING(LossyImageCompressionMethod, '\\'), ''), '(absent)') AS lossy_method,
    CASE WHEN ARRAY_LENGTH(LossyImageCompressionRatio) = 0 OR LossyImageCompressionRatio IS NULL THEN 'absent'
         WHEN SAFE_CAST(LossyImageCompressionRatio[OFFSET(0)] AS FLOAT64) IS NULL THEN 'unparseable'
         WHEN SAFE_CAST(LossyImageCompressionRatio[OFFSET(0)] AS FLOAT64) < 2 THEN '<2'
         WHEN SAFE_CAST(LossyImageCompressionRatio[OFFSET(0)] AS FLOAT64) < 5 THEN '2-5'
         WHEN SAFE_CAST(LossyImageCompressionRatio[OFFSET(0)] AS FLOAT64) < 10 THEN '5-10'
         WHEN SAFE_CAST(LossyImageCompressionRatio[OFFSET(0)] AS FLOAT64) < 20 THEN '10-20' ELSE '>=20' END
      || IF(ARRAY_LENGTH(LossyImageCompressionRatio) > 1, '+multi', '') AS lossy_ratio,
    CASE WHEN PixelPaddingValue IS NULL THEN 'absent' WHEN PixelPaddingValue = 0 THEN 'zero'
         WHEN PixelPaddingValue < 0 THEN 'negative' WHEN PixelPaddingValue >= 32768 THEN '>=32768' ELSE 'positive' END
      || IF(PixelPaddingRangeLimit IS NOT NULL, '+rangelimit', '') AS padding,
    CASE WHEN SmallestImagePixelValue IS NULL THEN 'absent' WHEN SmallestImagePixelValue < 0 THEN 'negative'
         WHEN SmallestImagePixelValue >= 32768 THEN '>=32768' ELSE 'nonneg' END AS smallest_value,
    IFNULL(RescaleType, '(absent)') AS rescale_type,
    IF(ARRAY_LENGTH(VOILUTSequence) > 0, 'present', 'absent') AS voi_lut,
    CASE WHEN ARRAY_LENGTH(RedPaletteColorLookupTableDescriptor) > 0
         THEN ARRAY_TO_STRING(ARRAY(SELECT CAST(x AS STRING) FROM UNNEST(RedPaletteColorLookupTableDescriptor) x), '/')
         ELSE 'absent' END || IF(LargePaletteColorLookupTableUID IS NOT NULL, '+large', '') AS palette,
    IF(ARRAY_LENGTH(IconImageSequence) > 0, 'present', 'absent') AS icon,
    IF(ARRAY_LENGTH(OverlayRows) > 0, 'present', 'absent') AS overlay,
    IFNULL(PresentationLUTShape, '(absent)') AS presentation_lut,
    FORMAT('%s%s%s', IF(MOD(IFNULL(`Rows`, 0), 2) = 1, 'rows-odd ', ''), IF(MOD(IFNULL(`Columns`, 0), 2) = 1, 'cols-odd ', ''),
           IF(BitsAllocated = 1 AND MOD(IFNULL(`Rows`, 0) * IFNULL(`Columns`, 0), 8) != 0, 'bitpacked-unaligned', '')) AS odd_dims,
    -- expected pixel bytes; for uncompressed, overhead = instance_size - expected
    SAFE_CAST(`Rows` AS FLOAT64) * `Columns` * IFNULL(SAFE_CAST(NumberOfFrames AS INT64), 1) * IFNULL(SamplesPerPixel, 1)
      * IF(BitsAllocated = 1, 0.125, BitsAllocated / 8) AS expected_bytes,
    IFNULL(collection_id, '(absent)') AS collection,
    IFNULL(CAST(DIV(EXTRACT(YEAR FROM StudyDate), 5) * 5 AS STRING), 'absent') AS year5,
    IFNULL(SAFE_CAST(NumberOfFrames AS INT64), 1) AS nframes
  FROM `bigquery-public-data.idc_current.dicom_all`
  WHERE BitsAllocated IS NOT NULL
),
inst AS (
  SELECT *,
    CASE WHEN expected_bytes IS NULL OR expected_bytes = 0 THEN 'unknown'
         WHEN ts IN ('1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2') THEN
           CASE WHEN instance_size - expected_bytes < 0 THEN 'short'
                WHEN instance_size - expected_bytes < 1024 THEN 'ovh<1k'
                WHEN instance_size - expected_bytes < 4096 THEN 'ovh<4k'
                WHEN instance_size - expected_bytes < 16384 THEN 'ovh<16k'
                WHEN instance_size - expected_bytes < 65536 THEN 'ovh<64k'
                WHEN instance_size - expected_bytes < 1048576 THEN 'ovh<1M'
                WHEN instance_size - expected_bytes < 2 * expected_bytes THEN 'ovh>=1M'
                ELSE 'ovh>2x' END
         ELSE CASE WHEN instance_size / expected_bytes >= 1.05 THEN 'cr<1(bigger)'
                   WHEN instance_size / expected_bytes >= 0.5 THEN 'cr1-2'
                   WHEN instance_size / expected_bytes >= 0.2 THEN 'cr2-5'
                   WHEN instance_size / expected_bytes >= 0.1 THEN 'cr5-10'
                   WHEN instance_size / expected_bytes >= 0.02 THEN 'cr10-50' ELSE 'cr>=50' END END AS size_shape,
    FORMAT('%s|%s|%s|%s|%s', ts, photometric, bits, spp_planar, IF(nframes > 1, 'multi', 'single')) AS profile,
    FORMAT('%s|%s|%s|%s|%s', ts, impl_ver, manufacturer, model, software) AS combo
  FROM base
),
pairs AS (
  SELECT p.clue, p.value, h, instance_size
  FROM inst, UNNEST([
    STRUCT('ts' AS clue, ts AS value), ('sop_class', sop_class), ('manufacturer', manufacturer), ('model', model),
    ('software', software), ('impl_class', impl_class), ('impl_ver', impl_ver), ('src_ae', src_ae),
    ('conversion_type', conversion_type), ('image_type', image_type), ('modality', modality),
    ('photometric', photometric), ('bits', bits), ('high_bit', high_bit), ('spp_planar', spp_planar),
    ('frames', frames), ('lossy', lossy), ('lossy_method', lossy_method), ('lossy_ratio', lossy_ratio),
    ('padding', padding), ('smallest_value', smallest_value), ('rescale_type', rescale_type),
    ('voi_lut', voi_lut), ('palette', palette), ('icon', icon), ('overlay', overlay),
    ('presentation_lut', presentation_lut), ('odd_dims', odd_dims), ('size_shape', size_shape),
    ('collection', collection), ('year5', year5), ('profile', profile)]) p
),
freq AS (
  SELECT clue, value, COUNT(*) AS n,
    ARRAY_AGG(h ORDER BY instance_size > 100000000, instance_size > 500000000, MOD(ABS(h), 1000003) LIMIT 3) AS hs
  FROM pairs GROUP BY clue, value
),
combo AS (
  SELECT combo AS value, COUNT(*) AS n,
    ARRAY_AGG(h ORDER BY instance_size > 100000000, instance_size > 500000000, MOD(ABS(h), 1000003) LIMIT 2) AS hs
  FROM inst GROUP BY combo
),
wanted AS (
  SELECT DISTINCT x AS h FROM (
    SELECT x FROM freq, UNNEST(hs) x UNION ALL SELECT x FROM combo, UNNEST(hs) x
    UNION ALL SELECT h FROM inst WHERE MOD(ABS(h), 40000) = 17)
)
SELECT 'freq' AS kind, TO_JSON_STRING(f) AS j FROM freq f
UNION ALL SELECT 'combo', TO_JSON_STRING(c) FROM combo c
UNION ALL SELECT 'inst', TO_JSON_STRING(i) FROM inst i WHERE h IN (SELECT h FROM wanted)
