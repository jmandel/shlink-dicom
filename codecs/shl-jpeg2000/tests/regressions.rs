//! Codestreams from OpenJPEG's encoder with features the corpus lacks (progression order
//! changes over several tiles, precincts with an image offset, every code-block style, tile-parts
//! by layer, tiles with offsets), checked against OpenJPEG's own decode (`opj_decompress -o
//! X.rawl`: each component in turn, little-endian, 1 byte per sample up to 8 bits, else 2; signed
//! samples in their precision's two's complement), and
//! inputs fuzzing found.
use shl_jpeg2000::{decode, Options, Plane};

fn data(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// Our samples after the DC level shift, clamped to the precision, as OpenJPEG writes them.
fn samples(cs: &[u8]) -> Vec<i64> {
    let img = decode(cs, &Options::default()).unwrap();
    let mut out = Vec::new();
    for c in &img.components {
        let p = c.precision;
        let (shift, lo, hi) = if c.signed { (0, -(1i64 << (p - 1)), (1i64 << (p - 1)) - 1) } else { (1i64 << (p - 1), 0, (1i64 << p) - 1) };
        match &c.plane {
            Plane::Int(v) => out.extend(v.iter().map(|&x| (i64::from(x) + shift).clamp(lo, hi))),
            Plane::Float(v) => out.extend(v.iter().map(|&x| (x.round() as i64 + shift).clamp(lo, hi))),
        }
    }
    out
}

fn reference(name: &str, precision: u8, signed: bool) -> Vec<i64> {
    let raw = data(name);
    if precision <= 8 {
        raw.iter().map(|&b| if signed { i64::from(b as i8) } else { i64::from(b) }).collect()
    } else {
        raw.chunks_exact(2)
            .map(|b| {
                // Signed samples are written in their precision's two's complement.
                let v = u16::from_le_bytes([b[0], b[1]]);
                let s = 16 - u32::from(precision);
                if signed { i64::from(((v << s) as i16) >> s) } else { i64::from(v) }
            })
            .collect()
    }
}

#[test]
fn matches_openjpeg() {
    for (name, precision, signed) in [
        ("rgb-poc3", 8, false),
        ("g12-prec-cprl", 12, false),
        ("g12-modes", 12, false),
        ("s12-tp-l", 12, true),
        ("rgb-tiles-offset", 8, false),
    ] {
        let ours = samples(&data(&format!("opj-{name}.j2c")));
        let theirs = reference(&format!("opj-{name}.rawl"), precision, signed);
        assert_eq!(ours, theirs, "{name}");
    }
}

#[test]
fn fuzz_findings_are_errors_not_panics() {
    // COD code-block size bytes of 255 (the exponent overflowed u8).
    assert!(decode(&data("fuzz-cod-block-size-255.j2c"), &Options::default()).is_err());
    // An HT packet header that failed after the first cleanup pass was found.
    let _ = decode(&data("fuzz-ht-p0-past-passes.j2c"), &Options::default());
    // Damaged code-blocks with 31-bit coefficients, whose 5/3 synthesis overflows i32.
    let _ = decode(&data("fuzz-53-overflow.j2c"), &Options::default());
    // A MIXED tile whose readings all fail: the search gives up after a few attempts (this
    // took 2 s with a bound of 4,096).
    let t = std::time::Instant::now();
    let _ = decode(&data("fuzz-mixed-search.j2c"), &Options::default());
    assert!(t.elapsed().as_secs_f64() < 1.0);
}
