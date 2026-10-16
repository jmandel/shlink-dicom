//! Decode timing against jxl-oxide (single-threaded), median of N runs.
//! Usage: bench [--runs N] FILES...
use std::time::Instant;

fn oxide(data: &[u8]) -> usize {
    use jxl_oxide::{JxlImage, JxlThreadPool};
    let mut img = JxlImage::builder().pool(JxlThreadPool::none()).read(data).expect("jxl-oxide");
    let r = img.render_frame(0).expect("render");
    let mut s = r.stream_no_alpha();
    let mut buf = vec![0f32; (s.width() * s.height() * s.channels()) as usize];
    s.write_to_buffer(&mut buf)
}

fn ours(data: &[u8]) -> usize {
    let img = shl_jpegxl::decode(data, &shl_jpegxl::Options::default()).expect("shl-jpegxl");
    img.planes.len()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut runs = 5;
    if args.first().map(|s| s == "--runs").unwrap_or(false) {
        runs = args[1].parse().unwrap();
        args.drain(..2);
    }
    println!("{:<40} {:>10} {:>10} {:>7}", "file", "ours ms", "oxide ms", "ratio");
    let (mut to, mut tx) = (0.0, 0.0);
    for f in &args {
        let data = std::fs::read(f).unwrap();
        let mut a = Vec::new();
        let mut b = Vec::new();
        for _ in 0..runs {
            let t = Instant::now();
            std::hint::black_box(ours(&data));
            a.push(t.elapsed().as_secs_f64() * 1e3);
            let t = Instant::now();
            std::hint::black_box(oxide(&data));
            b.push(t.elapsed().as_secs_f64() * 1e3);
        }
        let (ma, mb) = (median(a), median(b));
        to += ma;
        tx += mb;
        let name = std::path::Path::new(f).file_name().unwrap().to_string_lossy();
        println!("{:<40} {:>10.2} {:>10.2} {:>7.2}", &name[..name.len().min(40)], ma, mb, mb / ma);
    }
    println!("{:<40} {:>10.2} {:>10.2} {:>7.2}", "TOTAL", to, tx, tx / to);
}
