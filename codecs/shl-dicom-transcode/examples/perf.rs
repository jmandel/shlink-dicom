//! `perf DIR TS MODE REPEATS`: throughput of one transcode stage over every file under DIR, in
//! native pixel MB/s, as the median and range of REPEATS runs. MODE: `encode` (encoder only, from
//! decoded pixels), `transcode` (the whole call, both self-checks included), `decode` (our
//! decoder on the encoded outputs: the pixel self-check's main cost), `memory` (each file's peak
//! heap during one transcode, beyond the input, as a multiple of the input size). Build with
//! `--features bench`; run under `taskset -c N` for one core.
use shl_dicom_transcode::bench;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

/// Counts live heap bytes and their peak.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        LIVE.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            if n > l.size() {
                let now = LIVE.fetch_add(n - l.size(), Relaxed) + n - l.size();
                PEAK.fetch_max(now, Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - n, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

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
    let a: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(&a[1]);
    let ts = a[2].as_str();
    let mode = a[3].as_str();
    let repeats: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(5);
    let mut paths = Vec::new();
    files(&dir, &mut paths);
    paths.sort();
    let inputs: Vec<Vec<u8>> = paths.iter().filter_map(|p| std::fs::read(p).ok()).collect();
    let frames: Vec<bench::Frames> = inputs.iter().filter_map(|b| bench::Frames::new(b)).collect();
    let pixel_bytes: usize = frames.iter().map(bench::Frames::bytes).sum();
    let outputs: Vec<Vec<u8>> = if mode == "decode" {
        inputs.iter().filter_map(|b| shl_dicom_transcode::transcode_part10(b, ts).ok()).collect()
    } else {
        Vec::new()
    };
    if mode == "memory" {
        for (p, b) in paths.iter().zip(&inputs) {
            let base = LIVE.load(Relaxed);
            PEAK.store(base, Relaxed);
            let out = shl_dicom_transcode::transcode_part10(b, ts);
            let peak = PEAK.load(Relaxed) - base;
            println!(
                "{{\"file\":\"{}\",\"ts\":\"{ts}\",\"input_mb\":{:.1},\"peak_mb\":{:.1},\"x_input\":{:.2},\"encoded\":{}}}",
                p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                b.len() as f64 / 1e6,
                peak as f64 / 1e6,
                peak as f64 / b.len() as f64,
                out.is_ok()
            );
        }
        return;
    }
    let mut rates = Vec::new();
    for _ in 0..repeats {
        let t0 = std::time::Instant::now();
        let mut sink = 0usize;
        match mode {
            "encode" => frames.iter().for_each(|f| sink += f.encode(ts)),
            "transcode" => inputs.iter().for_each(|b| sink += shl_dicom_transcode::transcode_part10(b, ts).map_or(0, |o| o.len())),
            "decode" => outputs.iter().for_each(|o| sink += bench::decode_len(o)),
            _ => panic!("mode: encode, transcode or decode"),
        }
        let s = t0.elapsed().as_secs_f64();
        std::hint::black_box(sink);
        rates.push(pixel_bytes as f64 / 1e6 / s);
    }
    rates.sort_by(f64::total_cmp);
    println!(
        "{{\"mode\":\"{mode}\",\"ts\":\"{ts}\",\"files\":{},\"mb\":{:.1},\"median\":{:.2},\"min\":{:.2},\"max\":{:.2}}}",
        frames.len(),
        pixel_bytes as f64 / 1e6,
        rates[rates.len() / 2],
        rates[0],
        rates[rates.len() - 1]
    );
}
