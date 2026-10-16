//! `transcode IN.dcm OUT.dcm`: re-encode one file as JPEG Lossless SV1 and print one line,
//! "encoded IN_BYTES OUT_BYTES PIXEL_IN PIXEL_OUT FRAMES MS" or "declined REASON" (OUT is then
//! not written). For the corpus checks in tools/check_corpus.py.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = args.as_slice() else {
        eprintln!("usage: transcode IN.dcm OUT.dcm");
        std::process::exit(64);
    };
    let bytes = std::fs::read(input).unwrap_or_else(|e| {
        eprintln!("cannot read {input}: {e}");
        std::process::exit(1)
    });
    let t0 = std::time::Instant::now();
    let (r, rep) = shl_dicom_transcode::transcode_part10_sv1_report(&bytes);
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    match r {
        Ok(out) => {
            std::fs::write(output, &out).unwrap_or_else(|e| {
                eprintln!("cannot write {output}: {e}");
                std::process::exit(1)
            });
            println!("encoded {} {} {} {} {} {ms:.2}", rep.input_bytes, rep.output_bytes, rep.pixel_bytes_in, rep.pixel_bytes_out, rep.frames);
        }
        Err(e) => println!("declined {e}"),
    }
}
