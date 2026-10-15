//! Extra vectors from `codec-corpus/formats/jpeg-ls/extra/gen_vectors.py` (T.87 conformance
//! streams, CharLS/DCMTK encodes at 2–16 bits, ILV 0/1/2, NEAR, LSE presets, HP transforms),
//! compared exactly with CharLS's decode. Skips if the vectors have not been generated.

use shl_codec_common::{ColorOut, FrameInfo, Photometric};
use std::fs;
use std::path::Path;

fn num(s: &str, k: &str) -> u32 {
    let i = s.find(&format!("\"{k}\":")).unwrap() + k.len() + 3;
    let t = s[i..].trim_start();
    t[..t.find(|c: char| !c.is_ascii_digit()).unwrap()].parse().unwrap()
}

#[test]
fn vectors_match_charls() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/jpeg-ls/extra/vectors");
    let Ok(rd) = fs::read_dir(&dir) else {
        eprintln!("skipping: {} not found (run gen_vectors.py)", dir.display());
        return;
    };
    let mut names: Vec<_> = rd
        .filter_map(|e| e.ok()?.path().file_stem().map(|s| s.to_string_lossy().to_string()))
        .collect();
    names.sort();
    names.dedup();
    let mut fails = Vec::new();
    for name in &names {
        let s = fs::read_to_string(dir.join(format!("{name}.json"))).unwrap();
        let bits = num(&s, "bits") as u16;
        let nc = num(&s, "components") as u16;
        let info = FrameInfo {
            rows: num(&s, "rows"),
            columns: num(&s, "columns"),
            samples_per_pixel: nc,
            bits_allocated: if bits <= 8 { 8 } else { 16 },
            bits_stored: bits,
            pixel_representation: 0,
            photometric: if nc == 1 { Photometric::Monochrome2 } else { Photometric::Rgb },
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.80".into(),
        };
        let cs = fs::read(dir.join(format!("{name}.jls"))).unwrap();
        let want: Vec<u16> = fs::read(dir.join(format!("{name}.raw"))).unwrap().chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        match shl_codec_jpeg_ls::decode_frame(&cs, &info) {
            Err(e) => fails.push(format!("{name}: {e}")),
            Ok(f) => {
                let got: Vec<u16> = if bits <= 8 { f.data.iter().map(|&b| u16::from(b)).collect() } else { f.data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect() };
                let diffs = got.iter().zip(&want).filter(|(a, b)| a != b).count();
                if got.len() != want.len() || diffs > 0 {
                    fails.push(format!("{name}: {diffs} samples differ (len {} vs {})", got.len(), want.len()));
                } else if name.starts_with("hp") != (f.color == ColorOut::Rgb) {
                    fails.push(format!("{name}: wrong ColorOut"));
                }
            }
        }
    }
    assert!(fails.is_empty(), "{} of {} vectors failed:\n{}", fails.len(), names.len(), fails.join("\n"));
    eprintln!("{} vectors ok", names.len());
}
