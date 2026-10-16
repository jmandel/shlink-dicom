//! Decodes a JPEG XL file to PGM/PPM (integer images) or PFM-like float dump, for comparison
//! with libjxl's djxl. Usage: jxl2pnm IN.jxl OUT.pnm
use shl_jpegxl::{decode, Options, Plane};
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&args[1]).expect("read input");
    let t = std::time::Instant::now();
    let img = match decode(&data, &Options::default()) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let dt = t.elapsed();
    let bits = img.bit_depth.bits;
    let maxv = (1u32 << bits) - 1;
    let n = (img.width * img.height) as usize;
    let nc = img.num_color;
    let mut out = Vec::new();
    write!(out, "{}\n{} {}\n{}\n", if nc == 1 { "P5" } else { "P6" }, img.width, img.height, maxv).unwrap();
    for i in 0..n {
        for c in 0..nc {
            let v = match &img.planes[c] {
                Plane::Int(d) => d[i] as u32,
                Plane::Float(d) => ((d[i] * maxv as f32 + 0.5).clamp(0.0, maxv as f32)) as u32,
            };
            if maxv > 255 {
                out.extend_from_slice(&(v as u16).to_be_bytes());
            } else {
                out.push(v as u8);
            }
        }
    }
    std::fs::write(&args[2], out).expect("write output");
    eprintln!("{}x{} {} ch, {} bits, {:.2} ms", img.width, img.height, nc, bits, dt.as_secs_f64() * 1e3);
}
