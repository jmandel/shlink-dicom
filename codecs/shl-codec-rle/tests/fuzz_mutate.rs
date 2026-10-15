//! Mutation fuzzing without cargo-fuzz: take each corpus frame, apply random byte flips,
//! insertions, deletions, truncations and header rewrites, and decode it with both the true
//! FrameInfo and a randomly perturbed one. Any panic fails the test.
//!
//! Iterations per test run: RLE_FUZZ_ITERS (default 20000). For a long run:
//!   RLE_FUZZ_ITERS=5000000 cargo test --release -p shl-codec-rle --test fuzz_mutate -- --nocapture

mod common;

use shl_codec_common::FrameInfo;
use shl_codec_rle::decode_frame;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

fn mutate(rng: &mut Rng, data: &mut Vec<u8>) {
    let ops = 1 + rng.below(8);
    for _ in 0..ops {
        match rng.below(7) {
            0 if !data.is_empty() => {
                let i = rng.below(data.len());
                data[i] = rng.next() as u8;
            }
            1 if !data.is_empty() => {
                let i = rng.below(data.len());
                data[i] ^= 1 << rng.below(8);
            }
            2 => {
                let i = rng.below(data.len() + 1);
                data.insert(i, rng.next() as u8);
            }
            3 if !data.is_empty() => {
                let i = rng.below(data.len());
                data.remove(i);
            }
            4 => {
                let n = rng.below(data.len() + 1);
                data.truncate(n);
            }
            5 if data.len() >= 64 => {
                // rewrite a header word with something interesting
                let w = rng.below(16);
                let v: u32 = match rng.below(5) {
                    0 => 0,
                    1 => u32::MAX,
                    2 => rng.below(20) as u32,
                    3 => 64 + rng.below(data.len()) as u32,
                    _ => rng.next() as u32,
                };
                data[4 * w..4 * w + 4].copy_from_slice(&v.to_le_bytes());
            }
            _ => {
                // fill a range with one PackBits header byte pattern
                if !data.is_empty() {
                    let i = rng.below(data.len());
                    let n = rng.below(16).min(data.len() - i);
                    let b = [0x80u8, 0x81, 0x7f, 0x00][rng.below(4)];
                    data[i..i + n].fill(b);
                }
            }
        }
    }
}

fn perturb(rng: &mut Rng, info: &FrameInfo) -> FrameInfo {
    let mut i = info.clone();
    match rng.below(6) {
        0 => i.rows = rng.below(300) as u32,
        1 => i.columns = rng.below(300) as u32,
        2 => i.samples_per_pixel = [0, 1, 2, 3, 4][rng.below(5)],
        3 => i.bits_allocated = [0, 1, 8, 12, 16, 24, 32, 64][rng.below(8)],
        4 => {
            i.rows = rng.next() as u32;
            i.columns = rng.next() as u32;
        }
        _ => {}
    }
    i
}

#[test]
fn mutated_frames_never_panic() {
    let iters: usize = std::env::var("RLE_FUZZ_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(20_000);
    let seed: u64 = std::env::var("RLE_FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0x5eed_1234_abcd_0001);
    let cases = common::load_cases();
    let mut seeds: Vec<(Vec<u8>, FrameInfo)> = Vec::new();
    for c in &cases {
        // a few frames per case is plenty; skip the big 800x600 frames to keep iterations fast
        for f in c.frames.iter().take(2) {
            if f.len() < 200_000 {
                seeds.push((f.clone(), c.info.clone()));
            }
        }
    }
    if seeds.is_empty() {
        eprintln!("no corpus frames; fuzzing synthetic inputs only");
    }
    let mut rng = Rng(seed | 1);
    let mut ok = 0usize;
    for it in 0..iters {
        let (mut data, info) = if seeds.is_empty() {
            let n = rng.below(512);
            ((0..n).map(|_| rng.next() as u8).collect(), FrameInfo {
                rows: 1 + rng.below(16) as u32,
                columns: 1 + rng.below(16) as u32,
                samples_per_pixel: 1,
                bits_allocated: 8,
                bits_stored: 8,
                pixel_representation: 0,
                photometric: shl_codec_common::Photometric::Monochrome2,
                planar_configuration: 0,
                transfer_syntax: "1.2.840.10008.1.2.5".into(),
            })
        } else {
            seeds[rng.below(seeds.len())].clone()
        };
        mutate(&mut rng, &mut data);
        let info = if it % 4 == 0 { perturb(&mut rng, &info) } else { info };
        if let Ok(d) = decode_frame(&data, &info) {
            assert_eq!(Some(d.data.len()), info.frame_bytes());
            ok += 1;
        }
    }
    eprintln!("{iters} mutated inputs, {ok} still decoded, no panics");
}
