//! Round trips through this repository's JPEG 2000 decoder (hayro); the corpus tools check
//! OpenJPEG, GDCM and dcmtk.
use super::*;
use shl_codec_common::{FrameInfo, Photometric};

fn decode(cs: &[u8], w: u32, h: u32, n: u16, p: u8, signed: bool) -> Vec<i32> {
    let ba = if p > 8 { 16 } else { 8 };
    let info = FrameInfo {
        rows: h,
        columns: w,
        samples_per_pixel: n,
        bits_allocated: ba,
        bits_stored: u16::from(p),
        pixel_representation: u16::from(signed),
        photometric: if n == 3 { Photometric::Rgb } else { Photometric::Monochrome2 },
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.90".into(),
    };
    let d = shl_codec_jpeg2000::decode_frame(cs, &info).unwrap();
    let mask = (1u32 << p) - 1;
    let ext = |v: u32| -> i32 {
        let v = v & mask;
        if signed && v >> (p - 1) & 1 == 1 { v as i32 - (1i32 << p) } else { v as i32 }
    };
    if ba == 8 {
        d.data.iter().map(|&b| ext(u32::from(b))).collect()
    } else {
        d.data.chunks_exact(2).map(|b| ext(u32::from(u16::from_le_bytes([b[0], b[1]])))).collect()
    }
}

fn round_trip(w: u32, h: u32, n: u16, p: u8, signed: bool, seed: u32) {
    let mut x = seed;
    let (lo, hi) = if signed { (-(1i64 << (p - 1)), (1i64 << (p - 1)) - 1) } else { (0, (1i64 << p) - 1) };
    let span = (hi - lo + 1) as u64;
    let s: Vec<i32> = (0..w * h * u32::from(n))
        .map(|i| {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
            // A smooth ramp with noise, and some extremes.
            let base = (u64::from(i / u32::from(n) % w) * span / u64::from(w)) as i64;
            let noise = i64::from(x >> 20) % 7 - 3;
            let v = if i % 97 == 0 { if i % 2 == 0 { lo } else { hi } } else { (lo + base + noise).clamp(lo, hi) };
            v as i32
        })
        .collect();
    let cs = encode_lossless(&s, w, h, n, p, signed).unwrap();
    assert_eq!(cs, encode_lossless(&s, w, h, n, p, signed).unwrap(), "deterministic");
    assert_eq!(decode(&cs, w, h, n, p, signed), s, "{w}x{h}x{n} {p}-bit signed={signed}");
}

#[test]
fn sizes_depths_and_signs() {
    for &(w, h) in &[(1, 1), (2, 3), (7, 5), (64, 64), (65, 63), (130, 70), (300, 17)] {
        for &(p, signed) in &[(8, false), (12, false), (12, true), (16, false), (16, true), (1, false), (5, true)] {
            round_trip(w, h, 1, p, signed, w * 31 + h);
        }
        round_trip(w, h, 3, 8, false, w + h);
    }
}

#[test]
fn flat_and_noisy() {
    let flat = vec![1234; 100 * 80];
    let cs = encode_lossless(&flat, 100, 80, 1, 12, false).unwrap();
    assert_eq!(decode(&cs, 100, 80, 1, 12, false), flat);
    let mut x = 7u32;
    let noisy: Vec<i32> = (0..200 * 150)
        .map(|_| {
            x = x.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
            (x >> 16) as i32
        })
        .collect();
    let cs = encode_lossless(&noisy, 200, 150, 1, 16, false).unwrap();
    assert_eq!(decode(&cs, 200, 150, 1, 16, false), noisy);
}

/// Random images (sizes, depths, signs, components, smooth or noisy) round-trip exactly.
/// $SHL_J2K_ENC_ITERS rounds (default 40).
#[test]
fn random_images_round_trip() {
    let iters: u32 = std::env::var("SHL_J2K_ENC_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(40);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for _ in 0..iters {
        let w = 1 + (rnd() % 300) as u32;
        let h = 1 + (rnd() % 300) as u32;
        let n = if rnd() % 3 == 0 { 3 } else { 1 };
        let p = 1 + (rnd() % 16) as u8;
        let signed = p > 1 && rnd() % 2 == 0;
        let (lo, hi) = if signed { (-(1i64 << (p - 1)), (1i64 << (p - 1)) - 1) } else { (0, (1i64 << p) - 1) };
        let smooth = rnd() % 2 == 0;
        let mut v = (lo + hi) / 2;
        let s: Vec<i32> = (0..w * h * u32::from(n))
            .map(|_| {
                v = if smooth { (v + (rnd() % 7) as i64 - 3).clamp(lo, hi) } else { lo + (rnd() % (hi - lo + 1) as u64) as i64 };
                v as i32
            })
            .collect();
        let cs = encode_lossless(&s, w, h, n, p, signed).unwrap();
        assert_eq!(decode(&cs, w, h, n, p, signed), s, "{w}x{h}x{n} {p}-bit signed={signed} smooth={smooth}");
    }
}
