//! Rough decode speed (minimum time per decode): `cargo run --release --example bench -- <file.jls> <rows> <cols> <components> <bits_allocated>`
use shl_codec_common::{FrameInfo, Photometric};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let cs = std::fs::read(&a[1]).expect("read");
    let p = |i: usize| a[i].parse::<u32>().expect("number");
    let info = FrameInfo {
        rows: p(2),
        columns: p(3),
        samples_per_pixel: p(4) as u16,
        bits_allocated: p(5) as u16,
        bits_stored: p(5) as u16,
        pixel_representation: 0,
        photometric: if p(4) == 1 { Photometric::Monochrome2 } else { Photometric::Rgb },
        planar_configuration: 0,
        transfer_syntax: String::new(),
    };
    let samples = f64::from(info.rows * info.columns * u32::from(info.samples_per_pixel));
    let n = (2e8 / samples).max(3.0) as u32;
    // Minimum over runs: the least disturbed by other load on the machine.
    let mut s = f64::INFINITY;
    for _ in 0..n {
        let t = Instant::now();
        shl_codec_jpeg_ls::decode_frame(&cs, &info).expect("decode");
        s = s.min(t.elapsed().as_secs_f64());
    }
    println!("{}: {:.2} ms/frame, {:.0} Msamples/s, {:.0} MB/s compressed", a[1].rsplit('/').next().unwrap_or(""), s * 1e3, samples / s / 1e6, cs.len() as f64 / s / 1e6);
}
