//! Native timing: `shl-htj2k-bench DIR` times every DIR/*.j2c (with its .json FrameInfo)
//! with each codec that decodes it, and prints the median of several runs.
use std::time::Instant;

fn field(json: &str, key: &str) -> String {
    let k = format!("\"{key}\":");
    let rest = &json[json.find(&k).expect(key) + k.len()..];
    rest.trim_start().trim_start_matches('"').split(['"', ',', '}']).next().unwrap().trim().to_string()
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: shl-htj2k-bench DIR");
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "j2c")).collect();
    files.sort();
    let only: Option<u32> = std::env::var("CODEC").ok().and_then(|v| v.parse().ok());
    for p in files {
        let cs = std::fs::read(&p).unwrap();
        let j = std::fs::read_to_string(p.with_extension("json")).unwrap();
        let n = |k: &str| field(&j, k).parse::<u32>().unwrap();
        let info = shl_htj2k_bench::info(n("rows"), n("columns"), n("samples_per_pixel") as u16, n("bits_allocated") as u16,
            n("bits_stored") as u16, n("pixel_representation") as u16, &field(&j, "photometric"));
        if std::env::var("HASH").is_ok() {
            // Print a hash of each frame's output (codec CODEC, default 1) for comparing builds.
            let codec = only.unwrap_or(1);
            let h = match shl_htj2k_bench::decode_bytes(codec, &cs, &info) {
                Some(out) => out.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)),
                None => 0,
            };
            println!("{} {h:016x}", p.file_name().unwrap().to_string_lossy());
            continue;
        }
        for codec in [0u32, 1].into_iter().filter(|c| only.is_none_or(|o| o == *c)) {
            let name = ["jpeg2000", "htj2k"][codec as usize];
            if shl_htj2k_bench::decode(codec, &cs, &info) < 0 {
                println!("{:28} {name:8} error", p.file_name().unwrap().to_string_lossy());
                continue;
            }
            let runs: usize = std::env::var("RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(if cs.len() > 2_000_000 { 3 } else { 7 });
            let mut t: Vec<f64> = (0..runs).map(|_| {
                let s = Instant::now();
                shl_htj2k_bench::decode(codec, &cs, &info);
                s.elapsed().as_secs_f64() * 1000.0
            }).collect();
            t.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("{:28} {name:8} {:8.1} ms", p.file_name().unwrap().to_string_lossy(), t[runs / 2]);
        }
    }
}
