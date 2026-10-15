//! Test helper for `decode_frame_scaled`: decode every frame of one case dumped by
//! extract_frames.py at 1/2^S and write the codec output (frames concatenated) to a file.
//! Prints "COLUMNS ROWS BYTES_PER_SAMPLE SAMPLES" on success; on a decode error prints it and
//! exits 3 (Unsupported) or 2 (Invalid). Used by codec-corpus/formats/jpeg-dct/scaled/check_scaled.py.
//! Usage: cargo run --release --example scaled_dump -- <frames/CASE dir> <S> <out.raw>
use shl_codec_common::{DecodeError, FrameInfo, Photometric};
use std::{env, fs, path::Path, process::exit};

fn field(text: &str, key: &str) -> String {
    let pat = format!("\"{key}\":");
    let rest = text[text.find(&pat).expect(key) + pat.len()..].trim_start();
    match rest.strip_prefix('"') {
        Some(r) => r[..r.find('"').unwrap()].to_string(),
        None => rest[..rest.find([',', '\n', '}']).unwrap()].trim().to_string(),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let dir = Path::new(&args[1]);
    let s: u8 = args[2].parse().unwrap();
    let text = fs::read_to_string(dir.join("info.json")).unwrap();
    let n = |k: &str| field(&text, k).parse::<u32>().unwrap();
    let info = FrameInfo {
        rows: n("rows"),
        columns: n("columns"),
        samples_per_pixel: n("samples_per_pixel") as u16,
        bits_allocated: n("bits_allocated") as u16,
        bits_stored: n("bits_stored") as u16,
        pixel_representation: n("pixel_representation") as u16,
        photometric: Photometric::parse(&field(&text, "photometric")),
        planar_configuration: n("planar_configuration") as u16,
        transfer_syntax: field(&text, "transfer_syntax"),
    };
    let mut out = Vec::new();
    let mut dims = (0, 0);
    for k in 0..n("frames") {
        let cs = fs::read(dir.join(format!("frame-{k}.bin"))).unwrap();
        match shl_codec_jpeg::decode_frame_scaled(&cs, &info, s) {
            Ok(d) => {
                dims = (d.columns, d.rows);
                out.extend_from_slice(&d.frame.data);
            }
            Err(e) => {
                println!("frame {k}: {e}");
                exit(if matches!(e, DecodeError::Unsupported(_)) { 3 } else { 2 });
            }
        }
    }
    fs::write(&args[3], out).unwrap();
    println!("{} {} {} {}", dims.0, dims.1, info.bytes_per_sample(), info.samples_per_pixel);
}
