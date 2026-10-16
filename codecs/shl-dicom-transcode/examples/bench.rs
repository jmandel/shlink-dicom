//! `bench DIR [REPEAT] [TS]`: transcode every file under DIR in one process and print the throughput
//! (native pixel MB per second, both self-checks included) and the compression ratio.
fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::Path::new(args.get(1).map(String::as_str).unwrap_or("."));
    let repeat: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let ts = args.get(3).map(String::as_str).unwrap_or(shl_dicom_transcode::JPEG_LOSSLESS_SV1);
    let mut paths = Vec::new();
    files(dir, &mut paths);
    paths.sort();
    let inputs: Vec<Vec<u8>> = paths.iter().filter_map(|p| std::fs::read(p).ok()).collect();
    let (mut pin, mut pout, mut n, mut declined) = (0usize, 0usize, 0usize, 0usize);
    let t0 = std::time::Instant::now();
    for _ in 0..repeat {
        for b in &inputs {
            let (r, rep) = shl_dicom_transcode::transcode_part10_report(b, ts);
            if r.is_ok() {
                pin += rep.pixel_bytes_in;
                pout += rep.pixel_bytes_out;
                n += 1;
            } else {
                declined += 1;
            }
        }
    }
    let s = t0.elapsed().as_secs_f64();
    println!(
        "{n} encoded, {declined} declined; pixel data {:.1} MB -> {:.1} MB (ratio {:.2}); {:.2} s, {:.1} MB/s",
        pin as f64 / 1e6,
        pout as f64 / 1e6,
        pin as f64 / pout.max(1) as f64,
        s,
        pin as f64 / 1e6 / s
    );
}
