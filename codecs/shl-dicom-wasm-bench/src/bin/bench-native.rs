//! Native runner for codecs/bench. Decodes each file with warm-up and measured runs and prints
//! one JSON object per file on stdout. Verification against the oracle is done by the caller
//! (codecs/bench/lib/verify.ts) on the output written with `--dump DIR`.
//!
//! bench-native [--warmup N] [--min-runs N] [--max-runs N] [--budget-ms MS] [--dump DIR] FILE...
//! bench-native --loop SECONDS FILE      decode one file repeatedly (for perf / flamegraph)

use std::fmt::Write as _;
use std::path::PathBuf;

use shl_dicom_wasm_bench::{decode_timed, now, quick_hash};

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut warmup, mut min_runs, mut max_runs, mut budget) = (2usize, 5usize, 30usize, 300.0f64);
    let mut dump: Option<PathBuf> = None;
    let mut loop_secs: Option<f64> = None;
    let mut files = Vec::new();
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_default();
        match a.as_str() {
            "--warmup" => warmup = val().parse().unwrap_or(2),
            "--min-runs" => min_runs = val().parse().unwrap_or(5),
            "--max-runs" => max_runs = val().parse().unwrap_or(30),
            "--budget-ms" => budget = val().parse().unwrap_or(300.0),
            "--dump" => dump = Some(PathBuf::from(val())),
            "--loop" => loop_secs = val().parse().ok(),
            _ => files.push(a),
        }
    }

    if let Some(secs) = loop_secs {
        let Some(f) = files.first() else { return };
        let bytes = std::fs::read(f).unwrap_or_default();
        let end = now() + secs * 1000.0;
        let mut n = 0u32;
        while now() < end {
            let (r, _) = decode_timed(&bytes);
            std::hint::black_box(r.map(|c| c.data.len()).ok());
            n += 1;
        }
        eprintln!("decoded {f} {n} times");
        return;
    }

    for (i, f) in files.iter().enumerate() {
        let bytes = match std::fs::read(f) {
            Ok(b) => b,
            Err(e) => {
                println!(
                    "{{\"file\":{},\"status\":-1,\"msg\":{}}}",
                    json_str(f),
                    json_str(&e.to_string())
                );
                continue;
            }
        };
        // Warm-up; the first run's output is the one dumped for verification.
        let mut first_hash = None;
        let mut status = 0;
        let mut msg = String::new();
        let mut est = 0.0;
        let mut cold = 0.0;
        let mut dump_path = String::new();
        for w in 0..warmup.max(1) {
            let (r, t) = decode_timed(&bytes);
            est = t.total_ms;
            if w == 0 {
                cold = t.total_ms;
            }
            match r {
                Ok(img) => {
                    if w == 0 {
                        first_hash = Some(quick_hash(&img.data));
                        if let Some(d) = &dump {
                            let p = d.join(format!("{i}.raw"));
                            // A short or failed write would show up later as a wrong output,
                            // so stop here instead.
                            if let Err(e) = std::fs::write(&p, &img.data) {
                                eprintln!("bench-native: writing {}: {e}", p.display());
                                std::process::exit(2);
                            }
                            dump_path = p.display().to_string();
                        }
                    }
                }
                Err(e) => {
                    status = e.exit_code();
                    msg = e.to_string();
                    break;
                }
            }
        }
        if status != 0 {
            println!(
                "{{\"file\":{},\"status\":{status},\"msg\":{}}}",
                json_str(f),
                json_str(&msg)
            );
            continue;
        }
        // Same rule as codecs/bench/lib/stats.mjs runCount.
        let n = if est > 2000.0 {
            3
        } else {
            ((budget / est.max(1e-3)).ceil() as usize).clamp(min_runs, max_runs)
        };
        let mut runs = String::new();
        let mut consistent = true;
        for k in 0..n {
            let (r, t) = decode_timed(&bytes);
            let h = r.as_ref().map(|c| quick_hash(&c.data)).ok();
            consistent &= h == first_hash;
            drop(r);
            if k > 0 {
                runs.push(',');
            }
            let _ = write!(
                runs,
                "[{:.4},{:.4},{:.4},{:.4}]",
                t.total_ms, t.parse_ms, t.codec_ms, t.normalise_ms
            );
        }
        println!(
            "{{\"file\":{},\"status\":0,\"cold\":{cold:.4},\"hash\":\"{:016x}\",\"consistent\":{consistent},\"dump\":{},\"runs\":[{runs}]}}",
            json_str(f),
            first_hash.unwrap_or(0),
            json_str(&dump_path)
        );
    }
}
