//! Profiling helper: decodes one file N times.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&a[1]).unwrap();
    let n: usize = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(1000);
    let t = std::time::Instant::now();
    for _ in 0..n {
        std::hint::black_box(shl_jpegxl::decode(&data, &shl_jpegxl::Options::default()).unwrap());
    }
    eprintln!("{:.3} ms/decode", t.elapsed().as_secs_f64() * 1e3 / n as f64);
}
