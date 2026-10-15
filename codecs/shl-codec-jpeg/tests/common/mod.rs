//! Helpers shared by the integration tests: load the frames dumped by
//! `codec-corpus/scripts/extract_frames.py --format jpeg-dct|jpeg-lossless`, without dependencies.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use shl_codec_common::{FrameInfo, Photometric};

pub fn frames_dir(fmt: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../codec-corpus/formats/{fmt}/frames"))
}

/// Value of a top-level field in a flat JSON object, as raw text (quotes stripped).
fn json_field(text: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":");
    let start = text.find(&pat)? + pat.len();
    let rest = text[start..].trim_start();
    if let Some(r) = rest.strip_prefix('"') {
        Some(r[..r.find('"')?].to_string())
    } else {
        let end = rest.find([',', '\n', '}']).unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

pub struct Case {
    pub name: String,
    pub info: FrameInfo,
    pub frames: Vec<Vec<u8>>,
    pub expect: String,
    pub max_abs: i64,
    pub oracle: PathBuf,
}

pub fn load_cases(fmt: &str) -> Vec<Case> {
    let dir = frames_dir(fmt);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut cases = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        let Ok(text) = fs::read_to_string(p.join("info.json")) else { continue };
        let num = |k: &str| json_field(&text, k).unwrap_or_else(|| panic!("{k} missing in {p:?}"));
        let n = |k: &str| num(k).parse::<u32>().unwrap();
        let info = FrameInfo {
            rows: n("rows"),
            columns: n("columns"),
            samples_per_pixel: n("samples_per_pixel") as u16,
            bits_allocated: n("bits_allocated") as u16,
            bits_stored: n("bits_stored") as u16,
            pixel_representation: n("pixel_representation") as u16,
            photometric: Photometric::parse(&num("photometric")),
            planar_configuration: n("planar_configuration") as u16,
            transfer_syntax: num("transfer_syntax"),
        };
        let count = n("frames") as usize;
        // A case whose frames could not all be extracted (the DICOM layer rejects it) is skipped.
        let Ok(frames) = (0..count).map(|k| fs::read(p.join(format!("frame-{k}.bin")))).collect::<Result<Vec<_>, _>>()
        else {
            eprintln!("skip {p:?}: frames missing");
            continue;
        };
        cases.push(Case {
            name: num("case"),
            info,
            frames,
            expect: num("expect"),
            max_abs: num("max_abs").parse().unwrap_or(0),
            oracle: PathBuf::from(num("oracle_npy")),
        });
    }
    cases.sort_by(|a, b| a.name.cmp(&b.name));
    cases
}

/// Read a C-order .npy file: returns (descr, shape, raw little-endian data).
pub fn read_npy(path: &Path) -> (String, Vec<usize>, Vec<u8>) {
    let b = fs::read(path).unwrap();
    assert_eq!(&b[..6], b"\x93NUMPY", "{path:?} is not .npy");
    let (hlen, hstart) = if b[6] == 1 {
        (u16::from_le_bytes([b[8], b[9]]) as usize, 10)
    } else {
        (u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize, 12)
    };
    let header = std::str::from_utf8(&b[hstart..hstart + hlen]).unwrap();
    assert!(header.contains("'fortran_order': False"));
    let d0 = header.find("'descr': '").unwrap() + 10;
    let descr = header[d0..d0 + header[d0..].find('\'').unwrap()].to_string();
    let s0 = header.find("'shape': (").unwrap() + 10;
    let shape = header[s0..s0 + header[s0..].find(')').unwrap()]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().unwrap())
        .collect();
    (descr, shape, b[hstart + hlen..].to_vec())
}
