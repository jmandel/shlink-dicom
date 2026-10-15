//! longtail-frames range IN.dcm FIRST COUNT OUT.raw   decode frames FIRST..FIRST+COUNT (canonical bytes)
//! longtail-frames hashall IN.dcm CHUNK                decode every frame, CHUNK frames per call,
//!                                                     print "INDEX SHA256" per frame, then "total N"
//! Exit codes as CONTRACT.md: 2 invalid, 3 unsupported. Only CHUNK decoded frames are held at once.
use sha2::{Digest, Sha256};
use shl_dicom_decode_wasm::decode_frames;
use std::io::Write;
use std::process::ExitCode;

fn fail(e: shl_dicom_decode_wasm::Error) -> ExitCode {
    eprintln!("{e}");
    ExitCode::from(if e.exit_code() == 2 { 2 } else { 3 })
}

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().collect();
    let bytes = match std::fs::read(&a[2]) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("invalid: cannot read: {e}");
            return ExitCode::from(2);
        }
    };
    match a[1].as_str() {
        "range" => {
            let first: usize = a[3].parse().unwrap_or(0);
            let count: usize = a[4].parse().unwrap_or(1);
            match decode_frames(&bytes, first, count) {
                Ok((c, _)) => {
                    std::fs::write(&a[5], &c.data).expect("write");
                    ExitCode::SUCCESS
                }
                Err(e) => fail(e),
            }
        }
        "hashall" => {
            let chunk: usize = a[3].parse().unwrap_or(16).max(1);
            let out = std::io::stdout();
            let mut out = out.lock();
            let (_, total) = match decode_frames(&bytes, 0, 1) {
                Ok(x) => x,
                Err(e) => return fail(e),
            };
            let mut i = 0;
            while i < total {
                let n = chunk.min(total - i);
                match decode_frames(&bytes, i, n) {
                    Ok((c, _)) => {
                        let fb = c.data.len() / n;
                        for k in 0..n {
                            let h = Sha256::digest(&c.data[k * fb..(k + 1) * fb]);
                            let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
                            writeln!(out, "{} {}", i + k, hex).ok();
                        }
                    }
                    Err(e) => {
                        writeln!(out, "error {i} {e}").ok();
                        return fail(e);
                    }
                }
                i += n;
            }
            writeln!(out, "total {total}").ok();
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: longtail-frames range IN FIRST COUNT OUT | hashall IN CHUNK");
            ExitCode::from(64)
        }
    }
}
