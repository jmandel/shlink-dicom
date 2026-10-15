//! Debug helper: decode the frames of one case dumped by extract_frames.py and write the raw
//! codec output (all frames concatenated) to a file.
//! Usage: cargo run --example decode_frames -- <frames/CASE dir> <out.raw>
use shl_codec_common::{FrameInfo, Photometric};
use std::{env, fs, path::Path, time::Instant};

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
    let reps: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(1);
    let t = Instant::now();
    for k in 0..n("frames") {
        let cs = fs::read(dir.join(format!("frame-{k}.bin"))).unwrap();
        for r in 0..reps {
            let d = shl_codec_jpeg::decode_frame(&cs, &info).unwrap_or_else(|e| panic!("frame {k}: {e}"));
            if r == 0 {
                out.extend_from_slice(&d.data);
            }
        }
    }
    eprintln!("{:.3} ms per frame decode", t.elapsed().as_secs_f64() * 1000.0 / (reps as f64 * f64::from(n("frames"))));
    fs::write(&args[2], out).unwrap();
}
