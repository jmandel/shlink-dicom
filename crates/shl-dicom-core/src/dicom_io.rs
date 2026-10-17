use std::io::{Cursor, Read};
use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_encoding::transfer_syntax::{Codec, TransferSyntax, TransferSyntaxIndex};
use dicom_object::{FileDicomObject, InMemDicomObject, OpenFileOptions};
use dicom_transfer_syntax_registry::TransferSyntaxRegistry;
use flate2::read::GzDecoder;
use std::sync::OnceLock;
use crate::{Error, Result};

const MEDIA_STORAGE_DIRECTORY_SOP_CLASS: &str = "1.2.840.10008.1.3.10";

/// A file that was not ingested, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

/// dicom-rs 0.7's registry plus a stand-in for the compressed transfer syntaxes it does not list:
/// the retired JPEG processes (1.2.840.10008.1.2.4.52–.66), JPEG XL (.110–.112), HTJ2K
/// (.201–.203), any later 1.2.840.10008.1.2.4.x, and Deflated Image Frame Compression
/// (1.2.840.10008.1.2.8.1). All of them encode the data set as explicit VR little endian with
/// encapsulated Pixel Data, which is all the packer needs: it reads headers and copies files byte
/// for byte. The transfer syntax reported for a file is always the one in its own header.
struct Syntaxes;

impl TransferSyntaxIndex for Syntaxes {
    fn get(&self, uid: &str) -> Option<&TransferSyntax> {
        static STAND_IN: OnceLock<TransferSyntax> = OnceLock::new();
        let uid = uid.trim_end_matches(|c: char| c.is_whitespace() || c == '\0');
        TransferSyntaxRegistry.get(uid).or_else(|| {
            (uid.starts_with("1.2.840.10008.1.2.4.") || uid == "1.2.840.10008.1.2.8.1").then(|| {
                STAND_IN.get_or_init(|| {
                    TransferSyntax::new_ele("1.2.840.10008.1.2.4", "Encapsulated, not listed by dicom-rs", Codec::EncapsulatedPixelData(None, None))
                })
            })
        })
    }
}

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
    pub study_time: Option<String>,
    pub accession_number: Option<String>,
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    /// Issuer of Patient ID (0010,0021).
    pub patient_id_issuer: Option<String>,
    pub patient_birth_date: Option<String>,
}

fn has_part10_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 132 && &bytes[128..132] == b"DICM"
}

/// Whether bytes without the Part 10 preamble start like a little endian data set: a first
/// element in groups 0x0001–0x0010 (the file meta group 0x0002 in a file that lost its preamble,
/// the identifying group 0x0008, or a low private group as some old files have).
fn looks_like_bare_dicom(bytes: &[u8]) -> bool {
    bytes.len() >= 64 && (0x01..=0x10).contains(&bytes[0]) && bytes[1] == 0x00
}

/// The SOP Class, SOP Instance and Study Instance UIDs among a data set's first top-level
/// elements, read as explicit or implicit VR little endian; None when there is no SOP Instance or
/// Study Instance UID.
fn scan_uids(ds: &[u8], explicit: bool) -> Option<(Option<String>, String, String)> {
    use crate::offset_tables::{read_el, skip_undefined};
    let (mut class, mut inst, mut study) = (None, None, None);
    let mut p = 0usize;
    while p + 8 <= ds.len() {
        let (tag, vr, vo, len) = read_el(ds, p, explicit)?;
        if tag > 0x0020_000D {
            break;
        }
        if len == 0xFFFF_FFFF {
            p = skip_undefined(ds, vo, explicit && &vr != b"UN", 1)?;
            continue;
        }
        let end = vo.checked_add(len as usize)?;
        let value = || Some(clean_uid(&String::from_utf8_lossy(ds.get(vo..end)?)));
        match tag {
            0x0008_0016 => class = value(),
            0x0008_0018 => inst = value(),
            0x0020_000D => study = value(),
            _ => {}
        }
        p = end;
    }
    Some((class.filter(|c| !c.is_empty()), inst.filter(|i| !i.is_empty())?, study.filter(|s| !s.is_empty())?))
}

/// A file meta group (with its group length) for a data set of `ts`.
fn file_meta(ts: &str, class: &str, inst: &str) -> Vec<u8> {
    let el = |b: &mut Vec<u8>, e: u16, vr: &[u8; 2], v: &[u8], pad: u8| {
        let mut v = v.to_vec();
        if v.len() % 2 == 1 {
            v.push(pad);
        }
        b.extend_from_slice(&0x0002u16.to_le_bytes());
        b.extend_from_slice(&e.to_le_bytes());
        b.extend_from_slice(vr);
        if vr == b"OB" {
            b.extend_from_slice(&[0, 0]);
            b.extend_from_slice(&(v.len() as u32).to_le_bytes());
        } else {
            b.extend_from_slice(&(v.len() as u16).to_le_bytes());
        }
        b.extend_from_slice(&v);
    };
    let mut m = Vec::new();
    el(&mut m, 0x0001, b"OB", &[0, 1], 0);
    el(&mut m, 0x0002, b"UI", class.as_bytes(), 0);
    el(&mut m, 0x0003, b"UI", inst.as_bytes(), 0);
    el(&mut m, 0x0010, b"UI", ts.as_bytes(), 0);
    el(&mut m, 0x0012, b"UI", shl_dicom_transcode::IMPLEMENTATION_CLASS_UID.as_bytes(), 0);
    let mut g = Vec::new();
    el(&mut g, 0x0000, b"UL", &(m.len() as u32).to_le_bytes(), 0);
    g.extend_from_slice(&m);
    g
}

/// A bare data set given the Part 10 preamble and file meta header (spec §11.1 step 3). The data
/// set's own bytes follow unchanged. A file that starts with its file meta group in explicit VR
/// (only the preamble missing) gets the preamble alone; one whose meta is in implicit VR gets a
/// new meta in place of it. The data set is read as explicit VR little endian when its first
/// element has a VR, else implicit VR little endian, then the other; the meta names the SOP
/// Class (Secondary Capture when the data set gives none) and SOP Instance UIDs it finds there.
/// Plain byte reading, no DICOM dictionary: the Share page runs this same code in wasm.
fn wrap_bare(raw: &[u8]) -> std::result::Result<Vec<u8>, String> {
    const EXPLICIT: &str = "1.2.840.10008.1.2.1";
    const IMPLICIT: &str = "1.2.840.10008.1.2";
    let part10 = |meta: &[u8], ds: &[u8]| {
        let mut b = Vec::with_capacity(132 + meta.len() + ds.len());
        b.extend_from_slice(&[0u8; 128]);
        b.extend_from_slice(b"DICM");
        b.extend_from_slice(meta);
        b.extend_from_slice(ds);
        b
    };
    let has_vr = |b: &[u8]| b.len() >= 6 && b[4].is_ascii_uppercase() && b[5].is_ascii_uppercase();
    let mut ds = raw;
    let mut order = if has_vr(raw) { [EXPLICIT, IMPLICIT] } else { [IMPLICIT, EXPLICIT] };
    if raw[0] == 0x02 {
        let (end, ts) = skip_meta_group(raw).ok_or("unreadable file meta")?;
        // A meta in explicit VR, as Part 10 requires: only the preamble is missing.
        if has_vr(raw) && ts.is_some() && raw.get(end..).is_some_and(|d| d.len() >= 8) {
            return Ok(part10(&[], raw));
        }
        ds = &raw[end..];
        if ds.len() < 8 {
            return Err("no data set after the file meta".into());
        }
        order = match ts.as_deref() {
            Some(IMPLICIT) => [IMPLICIT, EXPLICIT],
            Some(EXPLICIT) => [EXPLICIT, IMPLICIT],
            _ if has_vr(ds) => [EXPLICIT, IMPLICIT],
            _ => [IMPLICIT, EXPLICIT],
        };
    }
    let mut found_inst = false;
    for ts in order {
        match scan_uids(ds, ts == EXPLICIT) {
            Some((class, inst, _)) => {
                let class = class.unwrap_or_else(|| "1.2.840.10008.5.1.4.1.1.7".to_string());
                return Ok(part10(&file_meta(ts, &class, &inst), ds));
            }
            None => found_inst |= scan_inst(ds, ts == EXPLICIT),
        }
    }
    Err(if found_inst { "no Study Instance UID" } else { "no SOP Instance UID" }.into())
}

/// Whether the data set gives a SOP Instance UID (for the reason a wrap is refused).
fn scan_inst(ds: &[u8], explicit: bool) -> bool {
    use crate::offset_tables::read_el;
    let mut p = 0usize;
    while let Some((tag, _, vo, len)) = read_el(ds, p, explicit) {
        if tag == 0x0008_0018 {
            return true;
        }
        if tag > 0x0008_0018 || len == 0xFFFF_FFFF {
            return false;
        }
        match vo.checked_add(len as usize) {
            Some(e) => p = e,
            None => return false,
        }
    }
    false
}

/// The end of a file meta group at the start of `b` (explicit or implicit VR elements), and its
/// Transfer Syntax UID.
fn skip_meta_group(b: &[u8]) -> Option<(usize, Option<String>)> {
    let (mut p, mut ts) = (0usize, None);
    while p + 8 <= b.len() && u16::from_le_bytes([b[p], b[p + 1]]) == 0x0002 {
        let elem = u16::from_le_bytes([b[p + 2], b[p + 3]]);
        let vr = &b[p + 4..p + 6];
        let (len, at) = if vr.iter().all(u8::is_ascii_uppercase) {
            if matches!(vr, b"OB" | b"OW" | b"OF" | b"SQ" | b"UT" | b"UN") {
                (u32::from_le_bytes(b.get(p + 8..p + 12)?.try_into().ok()?) as usize, p + 12)
            } else {
                (u16::from_le_bytes([b[p + 6], b[p + 7]]) as usize, p + 8)
            }
        } else {
            (u32::from_le_bytes(b[p + 4..p + 8].try_into().ok()?) as usize, p + 8)
        };
        let value = b.get(at..at.checked_add(len)?)?;
        if elem == 0x0010 {
            ts = Some(clean_uid(&String::from_utf8_lossy(value)));
        }
        p = at + len;
    }
    Some((p, ts))
}

/// Why a file's name says it is not a DICOM instance, if it does.
fn non_dicom_name(path: &str) -> Option<String> {
    is_non_dicom_filename(path).then(|| {
        let fname = path.rsplit('/').next().unwrap_or(path);
        if fname.eq_ignore_ascii_case("DICOMDIR") {
            "a DICOMDIR (media directory), not an instance".to_string()
        } else {
            "not a DICOM file (by its name)".to_string()
        }
    })
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

/// Whether a file that starts with `prefix` (at least 132 bytes, or the whole file) is a bare data
/// set to wrap: not Part 10, and starting like a data set.
pub fn looks_like_bare_data_set(prefix: &[u8]) -> bool {
    !has_part10_magic(prefix) && looks_like_bare_dicom(prefix)
}

/// `raw` as the packer stores it when it is a bare data set: wrapped in Part 10 (spec §11.1
/// step 3; the data set's bytes follow unchanged). None when `raw` already is Part 10 or does not
/// start like a data set. The Share page calls this through shl-dicom-wasm.
pub fn wrap_bare_data_set(raw: &[u8]) -> std::result::Result<Option<Vec<u8>>, String> {
    if has_part10_magic(raw) || !looks_like_bare_dicom(raw) {
        return Ok(None);
    }
    wrap_bare(raw).map(Some)
}

const DEFLATED_LE: &str = "1.2.840.10008.1.2.1.99";
/// Inflated bytes of a deflated data set read for its header: far above any real header (Pixel
/// Data ends the read), small enough that a hostile stream cannot exhaust memory.
pub const DEFLATED_HEADER_CAP: u64 = 16 << 20;

/// The file meta group of a Part 10 file whose bytes start at `meta` (after "DICM"): its length,
/// transfer syntax, SOP Class and SOP Instance UIDs. Explicit VR little endian, as Part 10 says.
fn read_meta(meta: &[u8]) -> Option<(usize, String, String, String)> {
    let (end, ts) = skip_meta_group(meta)?;
    let mut p = 0;
    let (mut class, mut inst) = (String::new(), String::new());
    while p + 8 <= end {
        let elem = u16::from_le_bytes([meta[p + 2], meta[p + 3]]);
        let vr = &meta[p + 4..p + 6];
        let (len, at) = if matches!(vr, b"OB" | b"OW" | b"OF" | b"SQ" | b"UT" | b"UN") {
            (u32::from_le_bytes(meta.get(p + 8..p + 12)?.try_into().ok()?) as usize, p + 12)
        } else {
            (u16::from_le_bytes([meta[p + 6], meta[p + 7]]) as usize, p + 8)
        };
        let v = meta.get(at..at.checked_add(len)?)?;
        match elem {
            0x0002 => class = clean_uid(&String::from_utf8_lossy(v)),
            0x0003 => inst = clean_uid(&String::from_utf8_lossy(v)),
            _ => {}
        }
        p = at + len;
    }
    Some((end, ts?, class, inst))
}

/// A deflated data set (Deflated Explicit VR Little Endian) as dicom-rs can read its header: a
/// Part 10 file in Explicit VR Little Endian holding the first [`DEFLATED_HEADER_CAP`] inflated
/// bytes. Only the header is read from it; the file's own bytes are what gets packed.
fn deflated_header_view(class: &str, inst: &str, deflated: impl Read) -> std::result::Result<Vec<u8>, String> {
    let mut b = vec![0u8; 128];
    b.extend_from_slice(b"DICM");
    b.extend_from_slice(&file_meta("1.2.840.10008.1.2.1", class, inst));
    flate2::read::DeflateDecoder::new(deflated)
        .take(DEFLATED_HEADER_CAP)
        .read_to_end(&mut b)
        .map_err(|e| format!("deflated data set does not inflate: {e}"))?;
    Ok(b)
}

/// Reads a header from a view of a deflated file, keeping the file's own transfer syntax.
fn parse_deflated_view(source_name: &str, view: &[u8], final_bytes: Vec<u8>) -> std::result::Result<ParsedDicomInstance, String> {
    let obj = OpenFileOptions::new()
        .tranfer_syntax_index(Syntaxes)
        .read_until(Tag(0x7FE0, 0x0000))
        .from_reader(Cursor::new(view))
        .map_err(|e| format!("unreadable deflated DICOM: {e}"))?;
    let mut p = parsed_from_object(source_name, &obj, final_bytes, false)?;
    p.transfer_syntax_uid = DEFLATED_LE.to_string();
    Ok(p)
}

/// Parses a DICOM Part 10 byte buffer (or bare dataset, wrapping it in Part 10 if needed).
/// `Err` carries the reason a file is not ingested: not DICOM, a `DICOMDIR` index, or unreadable.
pub fn parse_dicom_bytes(source_name: &str, raw_bytes: Vec<u8>) -> std::result::Result<ParsedDicomInstance, String> {
    if let Some(reason) = non_dicom_name(source_name) {
        return Err(reason);
    }
    if raw_bytes.len() < 132 {
        return Err("too short to be a DICOM file".into());
    }

    if has_part10_magic(&raw_bytes) {
        if let Some((end, ts, class, inst)) = read_meta(&raw_bytes[132..]).filter(|m| clean_uid(&m.1) == DEFLATED_LE) {
            let _ = ts;
            let view = deflated_header_view(&class, &inst, &raw_bytes[132 + end..])?;
            return parse_deflated_view(source_name, &view, raw_bytes);
        }
    }
    let (file_obj, final_bytes, was_bare_wrapped) = if has_part10_magic(&raw_bytes) {
        let obj = OpenFileOptions::new()
            .tranfer_syntax_index(Syntaxes)
            .read_until(Tag(0x7FE0, 0x0000))
            .from_reader(Cursor::new(&raw_bytes))
            .map_err(|e| format!("unreadable DICOM: {e}"))?;
        (obj, raw_bytes, false)
    } else if looks_like_bare_dicom(&raw_bytes) {
        let bytes = wrap_bare(&raw_bytes)?;
        let obj = OpenFileOptions::new()
            .tranfer_syntax_index(Syntaxes)
            .read_until(Tag(0x7FE0, 0x0000))
            .from_reader(Cursor::new(&bytes))
            .map_err(|e| format!("unreadable DICOM data set: {e}"))?;
        (obj, bytes, true)
    } else {
        return Err("not a DICOM file (no DICM preamble)".into());
    };

    parsed_from_object(source_name, &file_obj, final_bytes, was_bare_wrapped)
}

/// Reads only the header of a Part 10 file from `reader` (up to Pixel Data), so a large file is
/// never held. `bytes` in the result is empty. Bare data sets are not handled here.
/// `Err` carries the reason the file is not ingested, as for [`parse_dicom_bytes`].
pub fn parse_dicom_header_reader<R: std::io::Read>(source_name: &str, mut reader: R) -> std::result::Result<ParsedDicomInstance, String> {
    if let Some(reason) = non_dicom_name(source_name) {
        return Err(reason);
    }
    // The preamble and file meta first, to tell a deflated data set (read through an inflated
    // view) from any other.
    let mut head = Vec::with_capacity(4096);
    (&mut reader).take(132 + 12).read_to_end(&mut head).map_err(|e| e.to_string())?;
    if head.len() == 144 && &head[128..132] == b"DICM" && &head[132..136] == [0x02, 0x00, 0x00, 0x00] && &head[136..138] == b"UL" {
        let group = u32::from_le_bytes(head[140..144].try_into().unwrap()) as u64;
        (&mut reader).take(group.min(1 << 20)).read_to_end(&mut head).map_err(|e| e.to_string())?;
        if let Some((end, ts, class, inst)) = read_meta(&head[132..]) {
            if clean_uid(&ts) == DEFLATED_LE {
                let rest = Cursor::new(head[132 + end..].to_vec()).chain(reader);
                let view = deflated_header_view(&class, &inst, rest)?;
                return parse_deflated_view(source_name, &view, Vec::new());
            }
        }
    }
    let file_obj = OpenFileOptions::new()
        .tranfer_syntax_index(Syntaxes)
        .read_until(Tag(0x7FE0, 0x0000))
        .from_reader(Cursor::new(head).chain(reader))
        .map_err(|e| format!("unreadable DICOM: {e}"))?;
    parsed_from_object(source_name, &file_obj, Vec::new(), false)
}

/// The header of the DICOM file at `path` (read up to Pixel Data), for packers that stream files
/// from disk. A file that is not Part 10 goes through [`parse_dicom_bytes`]: a bare data set is
/// wrapped in Part 10 (spec §11.1 step 3) and the file at `path` rewritten with the wrapped bytes,
/// so the seed packs what the CLI's pack and the Share page would. The returned `bytes` are empty.
pub fn parse_dicom_file_header(source_name: &str, path: &std::path::Path) -> std::result::Result<ParsedDicomInstance, String> {
    if let Some(reason) = non_dicom_name(source_name) {
        return Err(reason);
    }
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut head = Vec::with_capacity(132);
    (&mut f).take(132).read_to_end(&mut head).map_err(|e| e.to_string())?;
    if has_part10_magic(&head) {
        use std::io::Seek;
        f.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        return parse_dicom_header_reader(source_name, std::io::BufReader::with_capacity(64 << 10, f));
    }
    drop(f);
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut parsed = parse_dicom_bytes(source_name, raw)?;
    if parsed.was_bare_wrapped {
        std::fs::write(path, &parsed.bytes).map_err(|e| e.to_string())?;
    }
    parsed.bytes = Vec::new();
    Ok(parsed)
}

fn parsed_from_object(
    source_name: &str,
    file_obj: &FileDicomObject<InMemDicomObject>,
    final_bytes: Vec<u8>,
    was_bare_wrapped: bool,
) -> std::result::Result<ParsedDicomInstance, String> {
    let meta_sop_class = clean_uid(file_obj.meta().media_storage_sop_class_uid());
    let sop_class_uid = get_uid_tag(&file_obj, tags::SOP_CLASS_UID)
        .filter(|s| !s.is_empty())
        .unwrap_or(meta_sop_class);

    if sop_class_uid == MEDIA_STORAGE_DIRECTORY_SOP_CLASS {
        return Err("a DICOMDIR (media directory), not an instance".into());
    }

    let study_instance_uid = get_uid_tag(&file_obj, tags::STUDY_INSTANCE_UID)
        .ok_or("no Study Instance UID")?;
    let series_instance_uid = get_uid_tag(&file_obj, tags::SERIES_INSTANCE_UID)
        .unwrap_or_else(|| format!("{study_instance_uid}.0"));
    let sop_instance_uid = get_uid_tag(&file_obj, tags::SOP_INSTANCE_UID)
        .or_else(|| {
            let m = clean_uid(file_obj.meta().media_storage_sop_instance_uid());
            (!m.is_empty()).then_some(m)
        })
        .ok_or("no SOP Instance UID")?;

    let transfer_syntax_uid = clean_uid(file_obj.meta().transfer_syntax());

    Ok(ParsedDicomInstance {
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
        accession_number: get_str_tag(&file_obj, tags::ACCESSION_NUMBER),
        study_date: get_str_tag(&file_obj, tags::STUDY_DATE),
        study_time: get_str_tag(&file_obj, tags::STUDY_TIME),
        patient_name: get_str_tag(&file_obj, tags::PATIENT_NAME),
        patient_id: get_str_tag(&file_obj, tags::PATIENT_ID),
        patient_id_issuer: get_str_tag(&file_obj, tags::ISSUER_OF_PATIENT_ID),
        patient_birth_date: get_str_tag(&file_obj, tags::PATIENT_BIRTH_DATE),
    })
}

/// The largest archive entry read. Archive headers are not trusted for sizes: an entry larger
/// than this, by its header or by what it inflates to, is skipped with the reason. Real single
/// instances reach a few GB (a whole-slide level can pass 1 GB, and native Pixel Data is at most
/// 4 GiB − 2 bytes), so this fails a decompression bomb but not a real slide.
pub const MAX_ARCHIVE_ENTRY_BYTES: u64 = 4 << 30;
/// Most bytes reserved before an entry is read; the buffer grows as the bytes actually arrive.
const MAX_PREALLOCATE: u64 = 8 << 20;

/// Reads one archive entry that says it is `declared` bytes long, holding to
/// [`MAX_ARCHIVE_ENTRY_BYTES`]. `Err(Ok(reason))`: skip the entry; `Err(Err(e))`: a read error.
fn read_entry(r: impl Read, declared: u64) -> std::result::Result<Vec<u8>, std::result::Result<String, std::io::Error>> {
    let max = MAX_ARCHIVE_ENTRY_BYTES.min(usize::MAX as u64);
    let too_big = || Ok(format!("larger than the {} GiB limit for one file", MAX_ARCHIVE_ENTRY_BYTES >> 30));
    if declared > max {
        return Err(too_big());
    }
    let mut buf = Vec::with_capacity(declared.min(MAX_PREALLOCATE) as usize);
    r.take(max + 1).read_to_end(&mut buf).map_err(Err)?;
    if buf.len() as u64 > max {
        return Err(too_big());
    }
    Ok(buf)
}

/// The DICOM instances in a `.tar.gz`, and every other file in it with the reason it was skipped.
pub fn extract_dicom_from_tar_gz(tgz_bytes: &[u8]) -> Result<(Vec<ParsedDicomInstance>, Vec<Skipped>)> {
    let gz = GzDecoder::new(Cursor::new(tgz_bytes));
    let mut archive = tar::Archive::new(gz);
    let (mut out, mut skipped) = (Vec::new(), Vec::new());

    let entries = archive
        .entries()
        .map_err(|e| Error::Dicom(format!("tar entries: {e}")))?;

    // An entry whose header claims more than the limit is skipped unread; if that header lied,
    // the archive can't be followed past it.
    let mut after_oversize: Option<String> = None;
    for entry_res in entries {
        let mut entry = match (entry_res, &after_oversize) {
            (Ok(e), _) => e,
            (Err(e), Some(prev)) => {
                skipped.push(Skipped { name: format!("(the rest of the archive, after {prev})"), reason: format!("unreadable: {e}") });
                break;
            }
            (Err(e), None) => return Err(Error::Dicom(format!("tar entry: {e}"))),
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown.dcm".to_string());
        if path.split('/').any(|seg| seg.starts_with('.')) {
            skipped.push(Skipped { name: path, reason: "hidden file".into() });
            continue;
        }
        let declared = entry.size();
        let buf = match read_entry(&mut entry, declared) {
            Ok(b) => b,
            Err(Ok(reason)) => {
                after_oversize = (declared > MAX_ARCHIVE_ENTRY_BYTES).then(|| path.clone());
                skipped.push(Skipped { name: path, reason });
                continue;
            }
            Err(Err(e)) => return Err(Error::Dicom(format!("tar read {path}: {e}"))),
        };
        match parse_dicom_bytes(&path, buf) {
            Ok(parsed) => out.push(parsed),
            Err(reason) => skipped.push(Skipped { name: path, reason }),
        }
    }

    Ok((out, skipped))
}

/// The DICOM instances in a `.zip`, and every other file in it with the reason it was skipped.
pub fn extract_dicom_from_zip(zip_bytes: &[u8]) -> Result<(Vec<ParsedDicomInstance>, Vec<Skipped>)> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| Error::Dicom(format!("zip archive: {e}")))?;
    let (mut out, mut skipped) = (Vec::new(), Vec::new());

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| Error::Dicom(format!("zip entry {i}: {e}")))?;
        if !file.is_file() {
            continue;
        }
        let name = file.name().to_string();
        if name.split('/').any(|seg| seg.starts_with('.')) {
            skipped.push(Skipped { name, reason: "hidden file".into() });
            continue;
        }
        let declared = file.size();
        let buf = match read_entry(&mut file, declared) {
            Ok(b) => b,
            Err(Ok(reason)) => {
                skipped.push(Skipped { name, reason });
                continue;
            }
            // Zip entries stand alone, so one that can't be read (a size or CRC that doesn't
            // match its data) is skipped and the rest are still read.
            Err(Err(e)) => {
                skipped.push(Skipped { name, reason: format!("unreadable: {e}") });
                continue;
            }
        };
        match parse_dicom_bytes(&name, buf) {
            Ok(parsed) => out.push(parsed),
            Err(reason) => skipped.push(Skipped { name, reason }),
        }
    }

    Ok((out, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::offset_tables::tests::{synthetic, synthetic_ts};

    /// The synthetic slide under another transfer syntax UID.
    fn with_ts(uid: &str) -> Vec<u8> {
        synthetic_ts(uid, 3, &[1], false)
    }

    #[test]
    fn reads_syntaxes_missing_from_the_dicom_rs_registry() {
        for uid in ["1.2.840.10008.1.2.4.110", "1.2.840.10008.1.2.4.111", "1.2.840.10008.1.2.4.112", "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.203", "1.2.840.10008.1.2.4.55", "1.2.840.10008.1.2.8.1"] {
            let b = with_ts(uid);
            let p = parse_dicom_bytes("slide.dcm", b.clone()).unwrap();
            assert_eq!(p.transfer_syntax_uid, uid);
            assert_eq!(p.study_instance_uid, "1.2.3.4");
            assert_eq!(p.bytes, b);
            let h = parse_dicom_header_reader("slide.dcm", Cursor::new(&b)).unwrap();
            assert_eq!(h.sop_instance_uid, "1.2.3.4.5.6");
        }
    }

    #[test]
    fn a_bare_file_on_disk_is_wrapped_in_place() {
        let part10 = synthetic(3, &[1], false);
        let meta_len = u32::from_le_bytes(part10[140..144].try_into().unwrap()) as usize;
        let bare = part10[144 + meta_len..].to_vec();
        let dir = std::env::temp_dir().join(format!("shl-bare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("slide.dcm");
        std::fs::write(&path, &bare).unwrap();
        let h = parse_dicom_file_header("slide.dcm", &path).unwrap();
        let wrapped = std::fs::read(&path).unwrap();
        assert!(h.was_bare_wrapped && h.bytes.is_empty());
        assert_eq!(&wrapped[128..132], b"DICM");
        assert!(wrapped.ends_with(&bare));
        assert_eq!(h.sop_instance_uid, "1.2.3.4.5.6");
        // A Part 10 file is read in place, unchanged.
        std::fs::write(&path, &part10).unwrap();
        assert!(!parse_dicom_file_header("slide.dcm", &path).unwrap().was_bare_wrapped);
        assert_eq!(std::fs::read(&path).unwrap(), part10);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gives_a_reason_for_every_skipped_file() {
        let slide = synthetic(3, &[1], false);
        let reason = |name: &str, b: Vec<u8>| parse_dicom_bytes(name, b).unwrap_err();
        assert!(reason("DICOMDIR", slide.clone()).contains("DICOMDIR"));
        assert!(reason("notes.txt", slide.clone()).contains("by its name"));
        assert!(reason("a.dcm", vec![0; 10]).contains("too short"));
        assert!(reason("a.dcm", vec![1; 400]).contains("no DICM"));
        let mut broken = slide.clone();
        broken.truncate(200);
        assert!(reason("a.dcm", broken).contains("unreadable"));
        // A transfer syntax outside DICOM's own is reported, not dropped.
        let unknown = with_ts("1.2.3.4.5.6.7.8.9.10.11");
        assert!(reason("a.dcm", unknown).contains("unreadable"));
    }
}
