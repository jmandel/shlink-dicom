//! `shl-dicom-decode [--scale S] IN.dcm OUT.raw` per codec-corpus/CONTRACT.md.
//!
//! Exit 0: decoded; 2: invalid input; 3: unsupported. One line on stderr for 2 and 3. On exit 0,
//! each attribute the decoder had to infer is listed on stderr as "note: inferred NAME = VALUE: why".
//! `--scale S` decodes at 1/2^S size (CONTRACT.md, "Reduced-resolution decode") and prints
//! "COLUMNS ROWS" of the result on stdout.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (scale, input, output) = match args.as_slice() {
        [_, input, output] => (None, input, output),
        [_, flag, s, input, output] if flag == "--scale" => match s.parse::<u8>() {
            Ok(s) => (Some(s), input, output),
            Err(_) => {
                eprintln!("--scale takes 0 to 255");
                return ExitCode::from(64);
            }
        },
        _ => {
            eprintln!("usage: shl-dicom-decode [--scale S] IN.dcm OUT.raw");
            return ExitCode::from(64);
        }
    };
    let bytes = match std::fs::read(input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("invalid: cannot read {input}: {e}");
            return ExitCode::from(2);
        }
    };
    let result = match scale {
        None => shl_dicom_decode::decode_file(&bytes),
        Some(s) => shl_dicom_decode::decode_file_scaled(&bytes, s),
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
