//! Timing helper: decode every frame of one case dumped by extract_frames.py, repeatedly, from
//! memory. Prints the best (minimum) and median time per frame over `reps` passes, so a loaded
//! machine still gives a usable lower bound.
//! Usage: cargo run --release --example bench -- <frames/CASE dir> [reps]
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
    let reps: usize = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(10);
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
    let frames: Vec<Vec<u8>> =
        (0..n("frames")).map(|k| fs::read(dir.join(format!("frame-{k}.bin"))).unwrap()).collect();
    let mut times = Vec::with_capacity(reps);
    let mut sink = 0u64;
    for _ in 0..reps {
        let t = Instant::now();
        for cs in &frames {
            let d = shl_codec_jpeg::decode_frame(cs, &info).unwrap();
            sink = sink.wrapping_add(u64::from(d.data[d.data.len() / 2]));
        }
        times.push(t.elapsed().as_secs_f64() * 1000.0 / frames.len() as f64);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("min {:.3} ms  median {:.3} ms per frame ({} frames x {reps}) [{sink}]", times[0], times[reps / 2], frames.len());
}
