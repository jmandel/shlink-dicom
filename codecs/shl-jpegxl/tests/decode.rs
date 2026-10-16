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

/// Float samples of a colour PFM (rows stored bottom to top), interleaved, top row first.
fn pfm(name: &str) -> (usize, usize, Vec<f32>) {
    let d = data(name);
    let mut lines = d.splitn(4, |&b| b == b'\n');
    assert_eq!(lines.next().unwrap(), b"PF");
    let dims = String::from_utf8(lines.next().unwrap().to_vec()).unwrap();
    let mut it = dims.split_whitespace().map(|v| v.parse::<usize>().unwrap());
    let (w, h) = (it.next().unwrap(), it.next().unwrap());
    let big = !String::from_utf8(lines.next().unwrap().to_vec()).unwrap().trim().starts_with('-');
    let body = lines.next().unwrap();
    let vals: Vec<f32> = body
        .chunks(4)
        .map(|c| {
            let b = [c[0], c[1], c[2], c[3]];
            if big { f32::from_be_bytes(b) } else { f32::from_le_bytes(b) }
        })
        .collect();
    let mut out = Vec::with_capacity(vals.len());
    for y in (0..h).rev() {
        out.extend_from_slice(&vals[y * w * 3..(y + 1) * w * 3]);
    }
    (w, h, out)
}

// The next two files come from tests/data/make-test-files.c (libjxl 0.12.0's encoder API):
// `enc noise-ll.jxl 64 48 0 6400 0 0` and `enc ec3.jxl 64 48 3 0 0 0`.

#[test]
fn lossless_frame_with_noise_gets_the_noise() {
    // A lossless RGB frame with photon noise (ISO 6400): libjxl adds the noise, so it must not
    // take the exact-integer path.
    let img = decode(&data("noise-ll.jxl"), &Options::default()).unwrap();
    let (w, h, want) = pfm("noise-ll.djxl.pfm");
    assert_eq!((img.width as usize, img.height as usize), (w, h));
    let mut worst = 0f32;
    for (c, p) in img.planes.iter().take(3).enumerate() {
        let Plane::Float(p) = p else { panic!("a frame with noise should be rendered as floats") };
        for (i, &v) in p.iter().enumerate() {
            worst = worst.max((v - want[i * 3 + c]).abs());
        }
    }
    assert!(worst < 1e-4, "worst difference {worst}");
}

#[test]
fn three_extra_channels_fit_the_image_size_limit() {
    // RGB with alpha, depth and an optional channel, decoded with the limit set to the image
    // size, as the DICOM wrapper does.
    let d = data("ec3.jxl");
    let img = decode(&d, &Options { max_pixels: 64 * 48 }).unwrap();
    assert_eq!(img.planes.len(), 6);
    let (_, _, want) = pnm("ec3.djxl.ppm");
    for (c, p) in img.planes.iter().take(3).enumerate() {
        let Plane::Int(p) = p else { panic!("lossless output should be integers") };
        assert!(p.iter().enumerate().all(|(i, &v)| v as u32 == want[i * 3 + c]));
    }
    assert!(decode(&data("ec2.jxl"), &Options { max_pixels: 64 * 48 }).is_ok());
}

// Lossy (XYB) files tagged with other primaries, white points and transfer curves, from
// tests/data/make-colour-files.c (libjxl 0.12.0's encoder API): `enc2 prim-P-W-T-B.jxl P W T B 1`.
// Each must come back in its own colour space, as djxl gives it (`djxl F prim-….djxl.pfm`).
#[test]
fn xyb_output_in_the_image_colour_space() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("prim-") && n.ends_with(".jxl"))
        .collect();
    names.sort();
    assert_eq!(names.len(), 9);
    for name in names {
        let img = decode(&data(&name), &Options::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let (w, h, want) = pfm(&name.replace(".jxl", ".djxl.pfm"));
        assert_eq!((img.width as usize, img.height as usize), (w, h));
        let (mut peak, mut sq) = (0f64, 0f64);
        for (c, p) in img.planes.iter().take(3).enumerate() {
            let Plane::Float(p) = p else { panic!("{name}: lossy output should be floats") };
            for (i, &v) in p.iter().enumerate() {
                let d = f64::from(v.clamp(0.0, 1.0) - want[i * 3 + c].clamp(0.0, 1.0)).abs();
                peak = peak.max(d);
                sq += d * d;
            }
        }
        let rmse = (sq / (w * h * 3) as f64).sqrt();
        // PQ is steep near black, so it gets the most room; the others are within 1e-4.
        let lim = if name.contains("-pq-") { 1e-3 } else { 1e-4 };
        assert!(peak <= lim && rmse <= 5e-5, "{name}: peak {peak:.2e}, rmse {rmse:.2e}");
    }
}
