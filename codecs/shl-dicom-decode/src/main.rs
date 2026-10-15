//! `shl-dicom-decode [--scale S] [--frames A-B] IN.dcm OUT.raw` per codec-corpus/CONTRACT.md.
//!
//! Exit 0: decoded; 2: invalid input; 3: unsupported. One line on stderr for 2 and 3. On exit 0,
//! each attribute the decoder had to infer is listed on stderr as "note: inferred NAME = VALUE: why".
//! `--scale S` decodes at 1/2^S size (CONTRACT.md, "Reduced-resolution decode") and prints
//! "COLUMNS ROWS" of the result on stdout. `--frames A-B` decodes only frames A to B, counted from
//! 0 and inclusive (`--frames 7` is frame 7 alone); the output holds just those frames.

use std::process::ExitCode;

const USAGE: &str = "usage: shl-dicom-decode [--scale S] [--frames A-B] IN.dcm OUT.raw";

fn parse_frames(v: &str) -> Option<(usize, usize)> {
    let (a, b) = v.split_once('-').unwrap_or((v, v));
    let (a, b): (usize, usize) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (b >= a).then(|| (a, b - a + 1))
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (mut scale, mut frames, mut files) = (None, None, Vec::new());
    while let Some(a) = args.next() {
        match a.as_str() {
            "--scale" => match args.next().and_then(|s| s.parse::<u8>().ok()) {
                Some(s) => scale = Some(s),
                None => {
                    eprintln!("--scale takes 0 to 255");
                    return ExitCode::from(64);
                }
            },
            "--frames" => match args.next().as_deref().and_then(parse_frames) {
                Some(r) => frames = Some(r),
                None => {
                    eprintln!("--frames takes A-B with A <= B, counted from 0");
                    return ExitCode::from(64);
                }
            },
            _ => files.push(a),
        }
    }
    let [input, output] = files.as_slice() else {
        eprintln!("{USAGE}");
        return ExitCode::from(64);
    };
    let bytes = match std::fs::read(input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("invalid: cannot read {input}: {e}");
            return ExitCode::from(2);
        }
    };
    let result = match (scale, frames) {
        (None, None) => shl_dicom_decode::decode_file(&bytes),
        (Some(s), None) => shl_dicom_decode::decode_file_scaled(&bytes, s),
        (s, Some((first, count))) => shl_dicom_decode::decode_frames(&bytes, first, count, s.unwrap_or(0)),
    };
    match result {
        Ok(img) => {
            // Decoded, but some attributes had to be inferred: say which, one line each.
            for i in &img.inferred {
                eprintln!("note: inferred {} = {}: {}", i.attribute, i.value, i.reason);
            }
            if scale.is_some() {
                println!("{} {}", img.columns, img.rows);
            }
            if let Err(e) = std::fs::write(output, &img.data) {
                eprintln!("cannot write {output}: {e}");
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(if e.exit_code() == 2 { 2 } else { 3 })
        }
    }
}
