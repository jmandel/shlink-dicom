//! Native timing: `shl-j2k-bench DIR` times every DIR/*.j2c (with its .json FrameInfo)
//! with each codec that decodes it, and prints the median of several runs.
use std::time::Instant;

fn field(json: &str, key: &str) -> String {
    let k = format!("\"{key}\":");
    let rest = &json[json.find(&k).expect(key) + k.len()..];
    rest.trim_start().trim_start_matches('"').split(['"', ',', '}']).next().unwrap().trim().to_string()
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: shl-j2k-bench DIR");
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "j2c")).collect();
    files.sort();
    for p in files {
        let cs = std::fs::read(&p).unwrap();
        let j = std::fs::read_to_string(p.with_extension("json")).unwrap();
        let n = |k: &str| field(&j, k).parse::<u32>().unwrap();
        let info = shl_j2k_bench::info(n("rows"), n("columns"), n("samples_per_pixel") as u16, n("bits_allocated") as u16,
            n("bits_stored") as u16, n("pixel_representation") as u16, &field(&j, "photometric"));
        for codec in [0u32, 1] {
            let name = ["jpeg2000", "htj2k"][codec as usize];
            if shl_j2k_bench::decode(codec, &cs, &info) < 0 {
                println!("{:28} {name:8} error", p.file_name().unwrap().to_string_lossy());
                continue;
            }
            let runs = if cs.len() > 2_000_000 { 3 } else { 7 };
            let mut t: Vec<f64> = (0..runs).map(|_| {
                let s = Instant::now();
                shl_j2k_bench::decode(codec, &cs, &info);
                s.elapsed().as_secs_f64() * 1000.0
            }).collect();
            t.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("{:28} {name:8} {:8.1} ms", p.file_name().unwrap().to_string_lossy(), t[runs / 2]);
        }
    }
}
