use std::io::{Cursor, Read};
use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_object::{FileDicomObject, FileMetaTableBuilder, InMemDicomObject, OpenFileOptions};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use crate::{Error, Result};

const MEDIA_STORAGE_DIRECTORY_SOP_CLASS: &str = "1.2.840.10008.1.3.10";

#[derive(Debug, Clone)]
pub struct ParsedDicomInstance {
    pub source_name: String,
    pub bytes: Vec<u8>,
    pub was_bare_wrapped: bool,
    pub study_instance_uid: String,
    pub series_instance_uid: String,
    pub sop_instance_uid: String,
    pub sop_class_uid: String,
    pub transfer_syntax_uid: String,
    pub instance_number: Option<i32>,
    pub series_number: Option<i32>,
    pub modality: Option<String>,
    pub series_description: Option<String>,
    pub study_description: Option<String>,
    pub study_date: Option<String>,
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    pub patient_birth_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSlice {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub window_center: f64,
    pub window_width: f64,
    pub min_pixel: f64,
    pub max_pixel: f64,
    pub instance_number: Option<i32>,
    pub sop_instance_uid: String,
    pub transfer_syntax_uid: String,
}

#[derive(Debug, Clone)]
pub struct DecodedRawFrame {
    pub width: u32,
    pub height: u32,
    pub samples_per_pixel: u16,
    pub rgb_bytes: Vec<u8>,
    pub mono_values: Vec<f32>,
    pub default_wc: Option<f64>,
    pub default_ww: Option<f64>,
    pub min_pixel: f64,
    pub max_pixel: f64,
    pub invert: bool,
    pub instance_number: Option<i32>,
    pub sop_instance_uid: String,
    pub transfer_syntax_uid: String,
}

impl DecodedRawFrame {
    /// Applies Window Center / Window Width to an already-decoded frame in <1 ms without re-running JPEG/DICOM parsing.
    pub fn to_rgba(&self, override_wc: Option<f64>, override_ww: Option<f64>) -> DecodedSlice {
        let num_pixels = (self.width * self.height) as usize;
        if self.samples_per_pixel == 3 {
            let mut rgba = Vec::with_capacity(num_pixels * 4);
            for i in 0..num_pixels {
                let base = i * 3;
                if base + 2 < self.rgb_bytes.len() {
                    rgba.push(self.rgb_bytes[base]);
                    rgba.push(self.rgb_bytes[base + 1]);
                    rgba.push(self.rgb_bytes[base + 2]);
                    rgba.push(255);
                } else {
                    rgba.extend_from_slice(&[0, 0, 0, 255]);
                }
            }
            return DecodedSlice {
                width: self.width,
                height: self.height,
                rgba,
                window_center: 128.0,
                window_width: 256.0,
                min_pixel: 0.0,
                max_pixel: 255.0,
                instance_number: self.instance_number,
                sop_instance_uid: self.sop_instance_uid.clone(),
                transfer_syntax_uid: self.transfer_syntax_uid.clone(),
            };
        }

        let wc = override_wc
            .or(self.default_wc)
            .unwrap_or((self.min_pixel + self.max_pixel) * 0.5);
        let ww = override_ww
            .or(self.default_ww)
            .unwrap_or((self.max_pixel - self.min_pixel).max(1.0))
            .max(1.0);

        let low = (wc - ww * 0.5) as f32;
        let inv_range = (255.0 / ww) as f32;
        let invert = self.invert;

        let mut rgba = vec![255u8; num_pixels * 4];
        for (i, &v) in self.mono_values.iter().enumerate() {
            let mut norm = ((v - low) * inv_range).clamp(0.0, 255.0) as u8;
            if invert {
                norm = 255 - norm;
            }
            let base = i * 4;
            rgba[base] = norm;
            rgba[base + 1] = norm;
            rgba[base + 2] = norm;
        }

        DecodedSlice {
            width: self.width,
            height: self.height,
            rgba,
            window_center: wc,
            window_width: ww,
            min_pixel: self.min_pixel,
            max_pixel: self.max_pixel,
            instance_number: self.instance_number,
            sop_instance_uid: self.sop_instance_uid.clone(),
            transfer_syntax_uid: self.transfer_syntax_uid.clone(),
        }
    }
}

fn has_part10_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 132 && &bytes[128..132] == b"DICM"
}

fn looks_like_bare_dicom(bytes: &[u8]) -> bool {
    // Bare little-endian DICOM datasets begin with a group 0x0008 element (bytes 08 00 .. ..)
    bytes.len() >= 64 && bytes[0] == 0x08 && bytes[1] == 0x00
}

fn is_non_dicom_filename(path: &str) -> bool {
    let fname = path.rsplit('/').next().unwrap_or(path);
    let upper = fname.to_ascii_uppercase();
    if upper == "DICOMDIR" || upper == "AUTORUN.INF" {
        return true;
    }
    if let Some((_, ext)) = upper.rsplit_once('.') {
        matches!(
            ext,
            "DLL"
                | "EXE"
                | "BMP"
                | "INI"
                | "XML"
                | "HTML"
                | "HTM"
                | "TXT"
                | "RTF"
                | "PDF"
                | "APPCACHE"
                | "DCT"
                | "JAR"
                | "CAB"
                | "INF"
                | "BAT"
                | "ICO"
                | "PNG"
                | "JPG"
                | "JPEG"
                | "JS"
                | "CSS"
                | "CHM"
                | "HLP"
                | "OCX"
                | "MANIFEST"
        )
    } else {
        false
    }
}

fn clean_uid(s: &str) -> String {
    s.trim().trim_end_matches('\0').trim().to_string()
}

fn clean_str(s: &str) -> String {
    s.trim().trim_end_matches('\0').trim().to_string()
}

fn get_str_tag(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_str().ok())
        .map(|s| clean_str(&s))
        .filter(|s| !s.is_empty())
}

fn get_uid_tag(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_str().ok())
        .map(|s| clean_uid(&s))
        .filter(|s| !s.is_empty())
}

fn get_i32_tag(obj: &InMemDicomObject, tag: Tag) -> Option<i32> {
    obj.element(tag).ok().and_then(|e| e.to_int::<i32>().ok())
}

fn get_f64_first(obj: &InMemDicomObject, tag: Tag) -> Option<f64> {
    let elem = obj.element(tag).ok()?;
    if let Ok(v) = elem.to_float64() {
        return Some(v);
    }
    if let Ok(vs) = elem.to_multi_float64() {
        if let Some(&first) = vs.first() {
            return Some(first);
        }
    }
    if let Ok(s) = elem.to_str() {
        let first = s.split('\\').next()?.trim().trim_end_matches('\0');
        if let Ok(v) = first.parse::<f64>() {
            return Some(v);
        }
    }
    None
}

fn percentile_window(values: &[f32], min_val: f64, max_val: f64) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 1.0);
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let p01 = sorted[(n / 100).min(n - 1)] as f64;
    let p99 = sorted[(n.saturating_mul(99) / 100).min(n - 1)] as f64;
    if p99 > p01 {
        ((p01 + p99) * 0.5, (p99 - p01).max(1.0))
    } else {
        ((min_val + max_val) * 0.5, (max_val - min_val).max(1.0))
    }
}

/// Parses a DICOM Part 10 byte buffer (or bare dataset, wrapping it in Part 10 if needed).
/// Returns `Ok(None)` if the file is a `DICOMDIR` index rather than an instance.
pub fn parse_dicom_bytes(source_name: &str, raw_bytes: Vec<u8>) -> Result<Option<ParsedDicomInstance>> {
    if is_non_dicom_filename(source_name) || raw_bytes.len() < 132 {
        return Ok(None);
    }

    let (file_obj, final_bytes, was_bare_wrapped) = if has_part10_magic(&raw_bytes) {
        let obj = OpenFileOptions::new()
            .read_until(Tag(0x7FE0, 0x0000))
            .from_reader(Cursor::new(&raw_bytes))
            .map_err(|e| Error::Dicom(format!("{source_name}: {e}")))?;
        (obj, raw_bytes, false)
    } else if looks_like_bare_dicom(&raw_bytes) {
        // Attempt to parse bare dataset and wrap in Part 10 preamble + file meta header.
        let full_obj: FileDicomObject<InMemDicomObject> = OpenFileOptions::new()
            .from_reader(Cursor::new(&raw_bytes))
            .map_err(|e| Error::Dicom(format!("{source_name}: {e}")))?;
        let sop_class = get_uid_tag(&full_obj, tags::SOP_CLASS_UID)
            .unwrap_or_else(|| "1.2.840.10008.5.1.4.1.1.7".to_string());
        let sop_inst = get_uid_tag(&full_obj, tags::SOP_INSTANCE_UID)
            .unwrap_or_else(|| "2.25.1".to_string());
        let dataset: InMemDicomObject = full_obj.into_inner();
        let wrapped_obj = dataset
            .with_meta(
                FileMetaTableBuilder::new()
                    .transfer_syntax("1.2.840.10008.1.2.1")
                    .media_storage_sop_class_uid(sop_class)
                    .media_storage_sop_instance_uid(sop_inst),
            )
            .map_err(|e| Error::Dicom(format!("meta build for {source_name}: {e}")))?;
        let mut buf = Vec::new();
        wrapped_obj
            .write_all(&mut buf)
            .map_err(|e| Error::Dicom(format!("write Part 10 for {source_name}: {e}")))?;
        (wrapped_obj, buf, true)
    } else {
        return Ok(None);
    };

    let meta_sop_class = clean_uid(file_obj.meta().media_storage_sop_class_uid());
    let sop_class_uid = get_uid_tag(&file_obj, tags::SOP_CLASS_UID)
        .filter(|s| !s.is_empty())
        .unwrap_or(meta_sop_class);

    if sop_class_uid == MEDIA_STORAGE_DIRECTORY_SOP_CLASS {
        return Ok(None);
    }

    let study_instance_uid = get_uid_tag(&file_obj, tags::STUDY_INSTANCE_UID)
        .ok_or_else(|| Error::Dicom(format!("{source_name}: missing StudyInstanceUID")))?;
    let series_instance_uid = get_uid_tag(&file_obj, tags::SERIES_INSTANCE_UID)
        .unwrap_or_else(|| format!("{study_instance_uid}.0"));
    let sop_instance_uid = get_uid_tag(&file_obj, tags::SOP_INSTANCE_UID)
        .or_else(|| {
            let m = clean_uid(file_obj.meta().media_storage_sop_instance_uid());
            (!m.is_empty()).then_some(m)
        })
        .ok_or_else(|| Error::Dicom(format!("{source_name}: missing SOPInstanceUID")))?;

    let transfer_syntax_uid = clean_uid(file_obj.meta().transfer_syntax());

    Ok(Some(ParsedDicomInstance {
        source_name: source_name.to_string(),
        bytes: final_bytes,
        was_bare_wrapped,
        study_instance_uid,
        series_instance_uid,
        sop_instance_uid,
        sop_class_uid,
        transfer_syntax_uid,
        instance_number: get_i32_tag(&file_obj, tags::INSTANCE_NUMBER),
        series_number: get_i32_tag(&file_obj, tags::SERIES_NUMBER),
        modality: get_str_tag(&file_obj, tags::MODALITY),
        series_description: get_str_tag(&file_obj, tags::SERIES_DESCRIPTION),
        study_description: get_str_tag(&file_obj, tags::STUDY_DESCRIPTION),
        study_date: get_str_tag(&file_obj, tags::STUDY_DATE),
        patient_name: get_str_tag(&file_obj, tags::PATIENT_NAME),
        patient_id: get_str_tag(&file_obj, tags::PATIENT_ID),
        patient_birth_date: get_str_tag(&file_obj, tags::PATIENT_BIRTH_DATE),
    }))
}

pub fn extract_dicom_from_tar_gz(tgz_bytes: &[u8]) -> Result<Vec<ParsedDicomInstance>> {
    let gz = GzDecoder::new(Cursor::new(tgz_bytes));
    let mut archive = tar::Archive::new(gz);
    let mut out = Vec::new();

    let entries = archive
        .entries()
        .map_err(|e| Error::Dicom(format!("tar entries: {e}")))?;

    for entry_res in entries {
        let mut entry = entry_res.map_err(|e| Error::Dicom(format!("tar entry: {e}")))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown.dcm".to_string());
        if path.split('/').any(|seg| seg.starts_with('.')) {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| Error::Dicom(format!("tar read {path}: {e}")))?;
        if let Ok(Some(parsed)) = parse_dicom_bytes(&path, buf) {
            out.push(parsed);
        }
    }

    Ok(out)
}

pub fn extract_dicom_from_zip(zip_bytes: &[u8]) -> Result<Vec<ParsedDicomInstance>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| Error::Dicom(format!("zip archive: {e}")))?;
    let mut out = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| Error::Dicom(format!("zip entry {i}: {e}")))?;
        if !file.is_file() {
            continue;
        }
        let name = file.name().to_string();
        if name.split('/').any(|seg| seg.starts_with('.')) || is_non_dicom_filename(&name) {
            continue;
        }
        let mut buf = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| Error::Dicom(format!("zip read {name}: {e}")))?;
        if let Ok(Some(parsed)) = parse_dicom_bytes(&name, buf) {
            out.push(parsed);
        }
    }

    Ok(out)
}

/// Decodes an uncompressed, RLE, or JPEG DICOM Part 10 slice into an 8-bit RGBA buffer
/// applying RescaleSlope/Intercept and WindowCenter/WindowWidth.
pub fn decode_dicom_slice(
    part10_bytes: &[u8],
    override_wc: Option<f64>,
    override_ww: Option<f64>,
) -> Result<DecodedSlice> {
    let raw = decode_dicom_raw_frame(part10_bytes)?;
    Ok(raw.to_rgba(override_wc, override_ww))
}

/// Decodes the DICOM Part 10 slice once into rescaled scalar pixel values (`DecodedRawFrame`)
/// using `shl-dicom-decode` for canonical pixel decoding across all transfer syntaxes,
/// so subsequent Window/Level adjustments can run in <1 ms without re-parsing DICOM or codecs.
pub fn decode_dicom_raw_frame(part10_bytes: &[u8]) -> Result<DecodedRawFrame> {
    let obj = OpenFileOptions::new()
        .read_until(Tag(0x7FE0, 0x0000))
        .from_reader(Cursor::new(part10_bytes))
        .map_err(|e| Error::Dicom(format!("open dicom headers for pixel decode: {e}")))?;

    let slope = get_f64_first(&obj, tags::RESCALE_SLOPE).unwrap_or(1.0);
    let intercept = get_f64_first(&obj, tags::RESCALE_INTERCEPT).unwrap_or(0.0);
    let tag_wc = get_f64_first(&obj, tags::WINDOW_CENTER);
    let tag_ww = get_f64_first(&obj, tags::WINDOW_WIDTH);
    let instance_number = get_i32_tag(&obj, tags::INSTANCE_NUMBER);
    let sop_instance_uid = get_uid_tag(&obj, tags::SOP_INSTANCE_UID).unwrap_or_default();

    let canonical = shl_dicom_decode::decode_file(part10_bytes)
        .map_err(|e| Error::Dicom(format!("shl-dicom-decode: {e}")))?;

    let cols = canonical.columns;
    let rows = canonical.rows;
    let num_pixels = (rows * cols) as usize;
    let bps = canonical.bytes_per_sample();
    let transfer_syntax_uid = canonical.transfer_syntax;

    if canonical.samples_per_pixel == 3 {
        let frame_bytes = num_pixels * 3;
        let rgb_bytes = if canonical.data.len() >= frame_bytes {
            canonical.data[..frame_bytes].to_vec()
        } else {
            canonical.data
        };
        return Ok(DecodedRawFrame {
            width: cols,
            height: rows,
            samples_per_pixel: 3,
            rgb_bytes,
            mono_values: Vec::new(),
            default_wc: Some(128.0),
            default_ww: Some(256.0),
            min_pixel: 0.0,
            max_pixel: 255.0,
            invert: false,
            instance_number,
            sop_instance_uid,
            transfer_syntax_uid,
        });
    }

    let mut values = Vec::with_capacity(num_pixels);
    let mut min_val = f64::INFINITY;
    let mut max_val = f64::NEG_INFINITY;

    if bps == 1 {
        for &b in canonical.data.iter().take(num_pixels) {
            let v = if canonical.signed {
                (b as i8) as f64
            } else {
                b as f64
            };
            let rescaled = v * slope + intercept;
            min_val = min_val.min(rescaled);
            max_val = max_val.max(rescaled);
            values.push(rescaled as f32);
        }
    } else if bps == 2 {
        for chunk in canonical.data.chunks_exact(2).take(num_pixels) {
            let v = if canonical.signed {
                i16::from_le_bytes([chunk[0], chunk[1]]) as f64
            } else {
                u16::from_le_bytes([chunk[0], chunk[1]]) as f64
            };
            let rescaled = v * slope + intercept;
            min_val = min_val.min(rescaled);
            max_val = max_val.max(rescaled);
            values.push(rescaled as f32);
        }
    } else if bps == 4 {
        for chunk in canonical.data.chunks_exact(4).take(num_pixels) {
            let v = if canonical.signed {
                i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64
            } else {
                u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64
            };
            let rescaled = v * slope + intercept;
            min_val = min_val.min(rescaled);
            max_val = max_val.max(rescaled);
            values.push(rescaled as f32);
        }
    }

    if !min_val.is_finite() {
        min_val = 0.0;
        max_val = 1.0;
    }

    let invert = canonical.photometric.eq_ignore_ascii_case("MONOCHROME1");
    let (default_wc, default_ww) = match (tag_wc, tag_ww.filter(|&w| w > 0.0)) {
        (Some(wc), Some(ww)) => (Some(wc), Some(ww)),
        _ => {
            let (pwc, pww) = percentile_window(&values, min_val, max_val);
            (Some(pwc), Some(pww))
        }
    };

    Ok(DecodedRawFrame {
        width: cols,
        height: rows,
        samples_per_pixel: 1,
        rgb_bytes: Vec::new(),
        mono_values: values,
        default_wc,
        default_ww,
        min_pixel: min_val,
        max_pixel: max_val,
        invert,
        instance_number,
        sop_instance_uid,
        transfer_syntax_uid,
    })
}
