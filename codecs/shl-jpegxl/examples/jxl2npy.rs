//! Decodes every displayed frame to a float32 .npy of shape (frames, height, width, channels),
//! colour channels then extra channels, nominal range 0..1 (the conformance suite's layout).
//! Usage: jxl2npy IN.jxl OUT.npy
use shl_jpegxl::{decode_frames, Options, Plane};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&args[1]).expect("read input");
    let t = std::time::Instant::now();
    let frames = match decode_frames(&data, &Options::default(), usize::MAX) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let dt = t.elapsed();
    let f0 = &frames[0];
    let (w, h, c) = (f0.width as usize, f0.height as usize, f0.planes.len());
    let mut body = Vec::with_capacity(frames.len() * w * h * c * 4);
    for f in &frames {
        let maxes: Vec<f32> = (0..c)
            .map(|i| {
                let bits = if i < f.num_color { f.bit_depth.bits } else { 8 };
                ((1u64 << bits) - 1) as f32
            })
            .collect();
        for i in 0..w * h {
            for (ci, p) in f.planes.iter().enumerate() {
                let v = match p {
                    Plane::Float(d) => d[i],
                    Plane::Int(d) => d[i] as f32 / maxes[ci],
                };
                body.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({}, {}, {}, {}), }}", frames.len(), h, w, c);
    while (header.len() + 11) % 64 != 0 {
        header.push(' ');
    }
    header.push('\n');
    let mut out = b"\x93NUMPY\x01\x00".to_vec();
    out.extend_from_slice(&(header.len() as u16).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&body);
    std::fs::write(&args[2], out).expect("write output");
    eprintln!("{} frame(s) {}x{}x{} in {:.1} ms", frames.len(), w, h, c, dt.as_secs_f64() * 1e3);
}
