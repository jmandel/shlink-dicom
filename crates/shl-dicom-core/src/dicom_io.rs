use std::io::{Cursor, Read};
use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_object::{FileDicomObject, FileMetaTableBuilder, InMemDicomObject, OpenFileOptions};
use flate2::read::GzDecoder;
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
