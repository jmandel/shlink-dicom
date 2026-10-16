//! Decode files repeatedly with this crate only (for profiling). Usage: bench N [--reduce R] FILE...
fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let n: usize = args.remove(0).parse().unwrap();
    let mut reduce = 0u8;
    if let Some(i) = args.iter().position(|a| a == "--reduce") {
        reduce = args[i + 1].parse().unwrap();
        args.drain(i..i + 2);
    }
    let files: Vec<Vec<u8>> = args.iter().map(|p| std::fs::read(p).unwrap()).collect();
    let t = std::time::Instant::now();
    for _ in 0..n {
        for f in &files {
            let _ = std::hint::black_box(shl_jpeg2000::decode(f, &shl_jpeg2000::Options { reduce }));
        }
    }
    println!("{:.1} ms per pass", t.elapsed().as_secs_f64() * 1e3 / n as f64);
}
