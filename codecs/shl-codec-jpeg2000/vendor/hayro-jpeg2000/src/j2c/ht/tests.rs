//! Round-trip tests for the HT block decoder: blocks coded by the (test-only) encoder must
//! decode back exactly. Adapted from ndic-htj2k's `tests/block_roundtrip.rs` (MIT), with a
//! deterministic generator in place of proptest. The refinement passes are covered by the
//! frame-level cross-check against oxideav in `shl-codec-htj2k`.

use alloc::vec;
use alloc::vec::Vec;

use super::{BlockPasses, HtScratch, decode_block, encode_block};

fn to_sm(v: i32, shift: u32) -> u32 {
    (if v < 0 { 0x8000_0000 } else { 0 }) | (v.unsigned_abs() << shift)
}

fn from_sm(v: u32, shift: u32) -> i32 {
    let m = ((v & 0x7FFF_FFFF) >> shift) as i32;
    if v & 0x8000_0000 != 0 { -m } else { m }
}

fn roundtrip(scratch: &mut HtScratch, coeffs: &[i32], width: usize, height: usize, k_max: u32) {
    let shift = 31 - k_max;
    let missing_msbs = k_max - 1;
    let buf: Vec<u32> = coeffs.iter().map(|&v| to_sm(v, shift)).collect();
    if buf.iter().fold(0u32, |a, &v| a | (v & 0x7FFF_FFFF)) < (1 << shift) {
        return; // all-zero blocks are never coded
    }
    let coded = encode_block(&buf, width, height, width, missing_msbs).expect("encode");
    // Decode into a strided buffer with junk around it: every sample of the block must be
    // overwritten and nothing outside it touched.
    let stride = width + 3;
    let mut out = vec![0xDEAD_BEEFu32; height * stride];
    decode_block(
        scratch,
        &coded,
        &mut out,
        width,
        height,
        stride,
        missing_msbs,
        &BlockPasses::cleanup_only(coded.len()),
        false,
    )
    .expect("decode");
    for y in 0..height {
        for x in 0..width {
            let got = out[y * stride + x];
            assert_eq!(from_sm(got, shift), coeffs[y * width + x], "({x},{y}) of {width}x{height} K_max={k_max}");
            // A significant sample carries the half-bin bit just below the cleanup LSB.
            if coeffs[y * width + x] != 0 && shift > 0 {
                assert_eq!(got & (1 << (shift - 1)), 1 << (shift - 1));
            }
        }
        for x in width..stride {
            assert_eq!(out[y * stride + x], 0xDEAD_BEEF, "wrote outside the block");
        }
    }
}

#[test]
fn fixed_blocks() {
    let mut s = HtScratch::default();
    for pos in 0..16 {
        let mut c = vec![0i32; 16];
        c[pos] = if pos % 2 == 0 { 5 } else { -3 };
        roundtrip(&mut s, &c, 4, 4, 8);
    }
    let ramp: Vec<i32> = (0..64).map(|i| (i - 32) * 3).collect();
    roundtrip(&mut s, &ramp, 8, 8, 10);
    let extremes: Vec<i32> = (0..64).map(|i| if i % 3 == 0 { 65535 } else { -65536 + i }).collect();
    roundtrip(&mut s, &extremes, 8, 8, 18);
    roundtrip(&mut s, &[1, -2, 3, -4, 5, -6, 7, -8], 8, 1, 6);
    roundtrip(&mut s, &[1, -2, 3, -4, 5, -6, 7, -8], 1, 8, 6);
    roundtrip(&mut s, &[-7], 1, 1, 5);
    let odd: Vec<i32> = (0..35).map(|i| (i * 7 % 23) - 11).collect();
    roundtrip(&mut s, &odd, 7, 5, 8);
    roundtrip(&mut s, &odd[..15], 5, 3, 8);
    roundtrip(&mut s, &odd[..9], 3, 3, 8);
}

/// Random blocks over every size class, density and K_max the 32-bit path supports. The
/// same scratch buffers are reused throughout, as in a frame decode.
#[test]
fn random_blocks() {
    let mut s = HtScratch::default();
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        state >> 32
    };
    let sizes = [(1, 1), (1, 64), (64, 1), (2, 2), (3, 5), (4, 4), (5, 7), (16, 16), (32, 32), (64, 64), (128, 32), (1024, 4), (4, 1024), (63, 65)];
    for case in 0..1500 {
        let (width, height) = sizes[case % sizes.len()];
        let k_max = 2 + (next() % 27) as u32; // 2..=28
        let density = next() % 101;
        let bound = 1u64 << (k_max - 1);
        let coeffs: Vec<i32> = (0..width * height)
            .map(|_| {
                if next() % 100 >= density {
                    0
                } else {
                    ((next() << 1 | next() & 1) % (2 * bound)) as i64 as i32 - bound as i32
                }
            })
            .collect();
        roundtrip(&mut s, &coeffs, width, height, k_max);
    }
}

/// Truncated and corrupted segments return an error or some output, never a panic.
#[test]
fn damaged_segments_do_not_panic() {
    let mut s = HtScratch::default();
    let coeffs: Vec<i32> = (0..4096).map(|i| ((i * 7919) % 513) - 256).collect();
    let buf: Vec<u32> = coeffs.iter().map(|&v| to_sm(v, 31 - 12)).collect();
    let coded = encode_block(&buf, 64, 64, 64, 11).unwrap();
    let mut out = vec![0u32; 4096];
    for cut in 0..coded.len() {
        let _ = decode_block(&mut s, &coded[..cut], &mut out, 64, 64, 64, 11, &BlockPasses::cleanup_only(cut), false);
    }
    let mut state = 7u32;
    for _ in 0..2000 {
        let mut d = coded.clone();
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let i = state as usize % d.len();
        d[i] ^= (state >> 24) as u8 | 1;
        for passes in 1..=3 {
            let split = d.len() * 3 / 4;
            let bp = BlockPasses { num_passes: passes, len_cleanup: if passes == 1 { d.len() } else { split }, len_refinement: if passes == 1 { 0 } else { d.len() - split } };
            let _ = decode_block(&mut s, &d, &mut out, 64, 64, 64, 11, &bp, passes == 3);
        }
    }
}

/// Speed probe, not a check: `cargo test --release -p hayro-jpeg2000 ht_block_speed -- --ignored --nocapture`.
#[test]
#[ignore]
fn ht_block_speed() {
    extern crate std;
    let mut s = HtScratch::default();
    let k_max = 14;
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let coeffs: Vec<i32> = (0..4096)
        .map(|_| {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            ((state >> 40) % 2001) as i32 - 1000
        })
        .collect();
    let buf: Vec<u32> = coeffs.iter().map(|&v| to_sm(v, 31 - k_max)).collect();
    let coded = encode_block(&buf, 64, 64, 64, k_max - 1).unwrap();
    let mut out = vec![0u32; 4096];
    let n = 4000;
    let t = std::time::Instant::now();
    for _ in 0..n {
        decode_block(&mut s, &coded, &mut out, 64, 64, 64, k_max - 1, &BlockPasses::cleanup_only(coded.len()), false).unwrap();
    }
    let ns = t.elapsed().as_nanos() as f64 / (n as f64 * 4096.0);
    std::println!("{ns:.2} ns/sample ({} bytes coded)", coded.len());
}
