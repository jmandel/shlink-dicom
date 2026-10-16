//! Small files made with cjxl 0.12.0 (sources and libjxl's output in tests/data):
//! lossless 16-bit grey, lossy XYB RGB, and lossless JPEG recompression.

use shl_jpegxl::{decode, reconstruct_jpeg, Options, Plane};

fn data(name: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)).unwrap()
}

/// Samples of a binary PGM/PPM (8 or 16 bit), interleaved.
fn pnm(name: &str) -> (usize, usize, Vec<u32>) {
    let d = data(name);
    let mut fields = Vec::new();
    let mut i = 0;
    while fields.len() < 4 {
        while d[i].is_ascii_whitespace() {
            i += 1;
        }
        let s = i;
        while !d[i].is_ascii_whitespace() {
            i += 1;
        }
        fields.push(String::from_utf8(d[s..i].to_vec()).unwrap());
    }
    let body = &d[i + 1..];
    let (w, h): (usize, usize) = (fields[1].parse().unwrap(), fields[2].parse().unwrap());
    let v = if fields[3] == "255" {
        body.iter().map(|&b| u32::from(b)).collect()
    } else {
        body.chunks(2).map(|c| u32::from(u16::from_be_bytes([c[0], c[1]]))).collect()
    };
    (w, h, v)
}

#[test]
fn lossless_16_bit_is_exact() {
    let img = decode(&data("ll16.jxl"), &Options::default()).unwrap();
    let (w, h, want) = pnm("ll16.pgm");
    assert_eq!((img.width as usize, img.height as usize, img.num_color), (w, h, 1));
    assert_eq!(img.bit_depth.bits, 16);
    let Plane::Int(got) = &img.planes[0] else { panic!("lossless output should be integers") };
    assert!(got.iter().zip(&want).all(|(&g, &e)| g as u32 == e));
}

#[test]
fn lossy_rgb_matches_libjxl() {
    let img = decode(&data("rgb8-d1.jxl"), &Options::default()).unwrap();
    // djxl's 8-bit output, which adds an ordered dither: within 1 of plain rounding.
    let (w, h, want) = pnm("rgb8-d1.djxl.ppm");
    assert_eq!((img.width as usize, img.height as usize, img.num_color), (w, h, 3));
    let mut worst = 0f32;
    for (c, p) in img.planes.iter().take(3).enumerate() {
        let Plane::Float(p) = p else { panic!("lossy output should be floats") };
        for (i, &v) in p.iter().enumerate() {
            let e = want[i * 3 + c] as f32;
            worst = worst.max(((v * 255.0).clamp(0.0, 255.0).round() - e).abs());
        }
    }
    assert!(worst <= 1.0, "worst difference {worst} of 255");
}

#[test]
fn jpeg_reconstruction_is_byte_exact() {
    let jpg = reconstruct_jpeg(&data("rgb8-jpeg.jxl"), &Options::default()).unwrap();
    assert_eq!(jpg, data("rgb8.jpg"));
}

#[test]
fn truncated_files_are_errors() {
    for name in ["ll16.jxl", "rgb8-d1.jxl", "rgb8-jpeg.jxl"] {
        let d = data(name);
        for n in 0..d.len() {
            assert!(decode(&d[..n], &Options::default()).is_err(), "{name} cut to {n} bytes decoded");
            let _ = reconstruct_jpeg(&d[..n], &Options::default());
        }
    }
}
