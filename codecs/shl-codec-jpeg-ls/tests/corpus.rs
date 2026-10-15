//! Decode every frame dumped by `codec-corpus/scripts/extract_frames.py --format jpeg-ls` and
//! compare with the oracle `.npy`, applying the CLI's Bits Stored masking / sign extension.
//! Skips (with a message) if the frames have not been extracted.

use shl_codec_common::{FrameInfo, Photometric};
use std::fs;
use std::path::{Path, PathBuf};

fn frames_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/jpeg-ls/frames")
}

fn json_num(s: &str, k: &str) -> i64 {
    let i = s.find(&format!("\"{k}\":")).unwrap_or_else(|| panic!("{k} missing")) + k.len() + 3;
    let t = s[i..].trim_start();
    let end = t.find(|c: char| !(c.is_ascii_digit() || c == '-')).unwrap();
    t[..end].parse().unwrap()
}

fn json_str(s: &str, k: &str) -> String {
    let i = s.find(&format!("\"{k}\":")).unwrap() + k.len() + 3;
    let t = s[i..].trim_start();
    let t = &t[1..];
    t[..t.find('"').unwrap()].to_string()
}

/// Minimal .npy reader: returns (dtype descr, flat values as i64).
fn read_npy(p: &Path) -> (String, Vec<i64>) {
    let b = fs::read(p).unwrap();
    assert_eq!(&b[..6], b"\x93NUMPY");
    let (hl, off) = if b[6] == 1 { (u16::from_le_bytes([b[8], b[9]]) as usize, 10) } else { (u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize, 12) };
    let hdr = std::str::from_utf8(&b[off..off + hl]).unwrap();
    let d = hdr.split("'descr':").nth(1).unwrap().trim_start();
    let descr = d[1..].split('\'').next().unwrap().to_string();
    assert!(hdr.contains("'fortran_order': False"));
    let body = &b[off + hl..];
    let vals = match descr.as_str() {
        "|u1" => body.iter().map(|&v| i64::from(v)).collect(),
        "|i1" => body.iter().map(|&v| i64::from(v as i8)).collect(),
        "<u2" => body.chunks_exact(2).map(|c| i64::from(u16::from_le_bytes([c[0], c[1]]))).collect(),
        "<i2" => body.chunks_exact(2).map(|c| i64::from(i16::from_le_bytes([c[0], c[1]]))).collect(),
        other => panic!("dtype {other}"),
    };
    (descr, vals)
}

#[test]
fn corpus_matches_oracle() {
    let dir = frames_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        eprintln!("skipping: {} not found (run extract_frames.py)", dir.display());
        return;
    };
    let mut cases: Vec<_> = rd.map(|e| e.unwrap().path()).collect();
    cases.sort();
    let mut failures = Vec::new();
    for case in &cases {
        let s = fs::read_to_string(case.join("info.json")).unwrap();
        if s.contains("extract_error") {
            failures.push(format!("{}: extract error", case.display()));
            continue;
        }
        let info = FrameInfo {
            rows: json_num(&s, "rows") as u32,
            columns: json_num(&s, "columns") as u32,
            samples_per_pixel: json_num(&s, "samples_per_pixel") as u16,
            bits_allocated: json_num(&s, "bits_allocated") as u16,
            bits_stored: json_num(&s, "bits_stored") as u16,
            pixel_representation: json_num(&s, "pixel_representation") as u16,
            photometric: Photometric::parse(&json_str(&s, "photometric")),
            planar_configuration: json_num(&s, "planar_configuration") as u16,
            transfer_syntax: json_str(&s, "transfer_syntax"),
        };
        let frames = json_num(&s, "frames") as usize;
        let max_abs = json_num(&s, "max_abs");
        let expect = json_str(&s, "expect");
        let name = case.file_name().unwrap().to_string_lossy().to_string();
        let mut got = Vec::new();
        let mut err = None;
        for k in 0..frames {
            let cs = fs::read(case.join(format!("frame-{k}.bin"))).unwrap();
            match shl_codec_jpeg_ls::decode_frame(&cs, &info) {
                Ok(f) => {
                    assert!(!f.planar);
                    let bs = info.bits_stored as u32;
                    let mask: u64 = (1u64 << bs) - 1;
                    let w = info.bytes_per_sample();
                    for c in f.data.chunks_exact(w) {
                        let mut v = c.iter().rev().fold(0u64, |a, &b| a << 8 | u64::from(b)) & mask;
                        if info.pixel_representation == 1 && v >> (bs - 1) & 1 == 1 {
                            v |= !mask;
                        }
                        got.push(v as i64);
                    }
                }
                Err(e) => {
                    err = Some(format!("frame {k}: {e}"));
                    break;
                }
            }
        }
        if expect == "error" {
            if err.is_none() {
                failures.push(format!("{name}: expected error, decoded"));
            }
            continue;
        }
        if let Some(e) = err {
            failures.push(format!("{name}: {e}"));
            continue;
        }
        if json_str(&s, "photometric").starts_with("YBR") {
            // The oracle is RGB; the CLI does the YBR→RGB step, so check.py covers this case.
            eprintln!("skip {name} (YBR: colour conversion happens in the CLI)");
            continue;
        }
        let (_, want) = read_npy(Path::new(&json_str(&s, "oracle_npy")));
        if want.len() != got.len() {
            failures.push(format!("{name}: {} samples, oracle {}", got.len(), want.len()));
            continue;
        }
        let worst = want.iter().zip(&got).map(|(a, b)| (a - b).abs()).max().unwrap_or(0);
        if worst > max_abs {
            failures.push(format!("{name}: max diff {worst} > {max_abs}"));
        } else {
            eprintln!("ok   {name} (max diff {worst})");
        }
    }
    assert!(failures.is_empty(), "{} of {} cases failed:\n{}", failures.len(), cases.len(), failures.join("\n"));
}
