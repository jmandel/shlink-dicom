//! Tests of the HT block decoder against the vendored hayro decoder it replaces (through the
//! test-only `ht-reference` feature of hayro-jpeg2000, which goes away with hayro): random
//! blocks from hayro's test encoder, damaged and random segments, and the code-blocks of real
//! HTJ2K codestreams.

use hayro_jpeg2000::ht_reference as reference;

use super::{decode_block, BlockPasses, Scratch};

/// A deterministic generator (PCG-style LCG, high bits).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 32) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

/// One `decode_block` call's arguments.
#[derive(Clone, Debug)]
struct Case {
    coded: Vec<u8>,
    width: usize,
    height: usize,
    stride: usize,
    missing_msbs: u32,
    num_passes: u32,
    len_cleanup: usize,
    len_refinement: usize,
    vertically_causal: bool,
}

struct Decoders {
    ours: Scratch,
    theirs: reference::Scratch,
}

impl Decoders {
    fn new() -> Self {
        Self { ours: Scratch::default(), theirs: reference::Scratch::default() }
    }

    /// Decodes `case` with both decoders into buffers of junk and checks that they agree on
    /// success and on every word of the buffer. Returns whether the decode succeeded.
    fn check(&mut self, case: &Case) -> bool {
        let len = (case.height - 1) * case.stride + case.width;
        let mut ours = vec![0xDEAD_BEEFu32; len + 3];
        let mut theirs = ours.clone();
        let passes = BlockPasses { num_passes: case.num_passes, len_cleanup: case.len_cleanup, len_refinement: case.len_refinement };
        let a = decode_block(&mut self.ours, &case.coded, &mut ours, case.width, case.height, case.stride, case.missing_msbs, &passes, case.vertically_causal);
        let b = reference::decode_block(
            &mut self.theirs,
            &case.coded,
            &mut theirs,
            case.width,
            case.height,
            case.stride,
            case.missing_msbs,
            case.num_passes,
            case.len_cleanup,
            case.len_refinement,
            case.vertically_causal,
        );
        assert_eq!(a.is_ok(), b.is_ok(), "{case:?}: ours {a:?}, reference {b:?}");
        if a.is_ok() {
            if let Some(i) = (0..ours.len()).find(|&i| ours[i] != theirs[i]) {
                panic!(
                    "{}x{} stride {} passes {} vc {} missing {}: word {i} (x {}, y {}): ours {:#010x}, reference {:#010x}\n{case:?}",
                    case.width,
                    case.height,
                    case.stride,
                    case.num_passes,
                    case.vertically_causal,
                    case.missing_msbs,
                    i % case.stride,
                    i / case.stride,
                    ours[i],
                    theirs[i]
                );
            }
        }
        a.is_ok()
    }
}

const SIZES: [(usize, usize); 24] = [
    (1, 1),
    (1, 2),
    (2, 1),
    (1, 64),
    (64, 1),
    (2, 2),
    (3, 3),
    (3, 5),
    (4, 4),
    (5, 7),
    (7, 5),
    (6, 9),
    (9, 6),
    (13, 11),
    (16, 16),
    (32, 32),
    (33, 31),
    (64, 64),
    (63, 65),
    (128, 32),
    (1024, 4),
    (4, 1024),
    (1024, 1),
    (1, 1024),
];

/// A random block of `k_max` magnitude planes, encoded by the reference encoder, with random
/// refinement bytes, pass count, stride and causal flag.
fn random_case(rng: &mut Rng, (width, height): (usize, usize), k_max: u32) -> Option<Case> {
    let shift = 31 - k_max;
    let density = rng.below(101);
    let bound = 1u64 << (k_max - 1);
    let samples: Vec<u32> = (0..width * height)
        .map(|_| {
            if rng.below(100) >= density {
                0
            } else {
                let m = ((u64::from(rng.next()) << 1 | u64::from(rng.next() & 1)) % bound) as u32 + 1;
                let m = if rng.below(4) == 0 { m.min(1 + rng.below(3)) } else { m };
                (if rng.below(2) == 0 { 0x8000_0000 } else { 0 }) | (m.min((1 << (k_max - 1)) as u32) << shift)
            }
        })
        .collect();
    if samples.iter().all(|&v| v & 0x7FFF_FFFF == 0) {
        return None; // all-zero blocks are not coded
    }
    let mut coded = reference::encode_block(&samples, width, height, width, k_max - 1)?;
    let len_cleanup = coded.len();
    let num_passes = 1 + rng.below(3);
    let len_refinement = if num_passes > 1 { rng.below(80) as usize } else { 0 };
    coded.extend((0..len_refinement).map(|_| refinement_byte(rng)));
    Some(Case {
        coded,
        width,
        height,
        stride: width + [0, 1, 3, 17][rng.below(4) as usize],
        missing_msbs: k_max - 1,
        num_passes,
        len_cleanup,
        len_refinement,
        vertically_causal: rng.below(2) == 0,
    })
}

/// A refinement byte, mostly 0x00..=0x7F and 0xFF so that stuffing gets exercised.
fn refinement_byte(rng: &mut Rng) -> u8 {
    match rng.below(8) {
        0 => 0xFF,
        1 => 0x7F,
        _ => rng.next() as u8,
    }
}

#[test]
fn lookup_tables_are_complete() {
    for t in [&super::tables::CXT_LOOKUP_0, &super::tables::CXT_LOOKUP_1] {
        assert!(t.iter().all(|&e| (e >> 5) & 7 != 0));
    }
}

/// Random blocks of every size class, density and precision: identical output words.
#[test]
fn random_blocks_match_reference() {
    let mut d = Decoders::new();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut total, mut ok) = (0, 0);
    for case in 0..12_000 {
        let size = SIZES[case % SIZES.len()];
        let k_max = 1 + rng.below(30); // 1..=30
        if let Some(c) = random_case(&mut rng, size, k_max) {
            total += 1;
            ok += usize::from(d.check(&c));
        }
    }
    assert!(ok * 10 > total * 9, "{ok} of {total} decoded");
    eprintln!("random blocks: {total} compared, {ok} decoded");
}

/// Mutate a valid case: flip bytes, truncate, move the segment boundary, change the pass
/// count or the precision.
fn mutate(rng: &mut Rng, c: &Case) -> Case {
    let mut c = c.clone();
    for _ in 0..1 + rng.below(4) {
        match rng.below(8) {
            0..=2 if !c.coded.is_empty() => {
                let i = rng.below(c.coded.len() as u32) as usize;
                c.coded[i] ^= (rng.next() as u8) | 1;
            }
            3 if !c.coded.is_empty() => {
                let cut = rng.below(c.coded.len() as u32 + 1) as usize;
                c.coded.truncate(cut);
                c.len_cleanup = c.len_cleanup.min(cut);
                c.len_refinement = cut - c.len_cleanup;
            }
            4 => {
                let total = c.len_cleanup + c.len_refinement;
                c.len_cleanup = rng.below(total as u32 + 1) as usize;
                c.len_refinement = total - c.len_cleanup;
            }
            5 => c.num_passes = rng.below(5),
            6 => c.missing_msbs = rng.below(31),
            _ => c.vertically_causal = !c.vertically_causal,
        }
    }
    c
}

/// Damaged segments: both decoders fail together or produce the same words; neither panics.
#[test]
fn damaged_blocks_match_reference() {
    let mut d = Decoders::new();
    let mut rng = Rng(7);
    let mut cases = 0;
    for case in 0..2_000 {
        let size = SIZES[case % SIZES.len()];
        let k_max = 1 + rng.below(30);
        let Some(c) = random_case(&mut rng, size, k_max) else { continue };
        for cut in [0, 1, 2, 3, c.len_cleanup / 2, c.len_cleanup.saturating_sub(1)] {
            let mut t = c.clone();
            t.coded.truncate(cut);
            t.len_cleanup = cut;
            t.len_refinement = 0;
            d.check(&t);
            cases += 1;
        }
        for _ in 0..10 {
            d.check(&mutate(&mut rng, &c));
            cases += 1;
        }
    }
    eprintln!("damaged blocks: {cases} compared");
}

/// Segments of random bytes, with a plausible Scup, at every size.
#[test]
fn random_bytes_match_reference() {
    let mut d = Decoders::new();
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let mut ok = 0;
    for case in 0..20_000 {
        let (width, height) = SIZES[case % SIZES.len()];
        let lcup = 2 + rng.below(300) as usize;
        let lref = rng.below(40) as usize;
        let mut coded: Vec<u8> = (0..lcup + lref).map(|_| rng.next() as u8).collect();
        let scup = 2 + rng.below(lcup.min(4079) as u32 - 1) as usize;
        coded[lcup - 1] = (scup >> 4) as u8;
        coded[lcup - 2] = (coded[lcup - 2] & 0xF0) | (scup & 0xF) as u8;
        let c = Case {
            coded,
            width,
            height,
            stride: width,
            missing_msbs: 10 + rng.below(20),
            num_passes: 1 + rng.below(3),
            len_cleanup: lcup,
            len_refinement: lref,
            vertically_causal: rng.below(2) == 0,
        };
        ok += usize::from(d.check(&c));
    }
    eprintln!("random segments: 20000 compared, {ok} decoded");
}

/// Hand-built argument errors: both decoders reject them.
#[test]
fn argument_errors_match_reference() {
    let mut d = Decoders::new();
    let coded = vec![0u8, 0x02, 0x00];
    let base = Case { coded, width: 4, height: 4, stride: 4, missing_msbs: 5, num_passes: 1, len_cleanup: 3, len_refinement: 0, vertically_causal: false };
    for c in [
        Case { width: 1025, height: 1, stride: 1025, ..base.clone() },
        Case { width: 65, height: 64, stride: 65, ..base.clone() },
        Case { missing_msbs: 30, ..base.clone() },
        Case { len_cleanup: 1, ..base.clone() },
        Case { len_cleanup: 4, ..base.clone() },
        Case { num_passes: 4, len_refinement: 0, ..base.clone() },
        Case { coded: vec![0, 0x02, 0x00, 0x00], num_passes: 4, len_refinement: 1, ..base.clone() },
    ] {
        d.check(&c);
    }
}

/// The HT code-blocks of real codestreams. Needs a directory of HTJ2K codestreams (`*.j2c`)
/// in `SHL_HT_CORPUS`, e.g. every frame of codec-corpus/formats/htj2k/samples/*.dcm, dumped
/// with pydicom's `generate_frames`; skipped without it. With `SHL_HT_BLOCKS` set, also
/// writes the blocks there for the speed probe.
#[test]
fn corpus_blocks_match_reference() {
    let Ok(dir) = std::env::var("SHL_HT_CORPUS") else {
        eprintln!("SHL_HT_CORPUS not set: skipped");
        return;
    };
    let blocks = record_corpus_blocks(&dir);
    let mut d = Decoders::new();
    let (mut passes, mut samples) = ([0usize; 4], 0usize);
    for b in &blocks {
        let c = Case {
            coded: b.coded.clone(),
            width: b.width,
            height: b.height,
            stride: b.width,
            missing_msbs: b.missing_msbs,
            num_passes: b.num_passes,
            len_cleanup: b.len_cleanup,
            len_refinement: b.coded.len() - b.len_cleanup,
            vertically_causal: b.vertically_causal,
        };
        assert!(d.check(&c), "corpus block failed to decode: {}x{}", b.width, b.height);
        passes[b.num_passes.min(3) as usize] += 1;
        samples += b.width * b.height;
    }
    eprintln!("corpus blocks: {} identical ({samples} samples; by pass count {passes:?})", blocks.len());
    if let Ok(path) = std::env::var("SHL_HT_BLOCKS") {
        std::fs::write(path, serialize(&blocks)).unwrap();
    }
}

fn record_corpus_blocks(dir: &str) -> Vec<reference::Block> {
    let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "j2c")).collect();
    paths.sort();
    let settings = hayro_jpeg2000::DecodeSettings { high_throughput: true, ..Default::default() };
    reference::start_recording();
    for p in &paths {
        let data = std::fs::read(p).unwrap();
        let image = match hayro_jpeg2000::Image::new(&data, &settings) {
            Ok(image) => image,
            Err(e) => {
                eprintln!("{}: reference parse failed: {e:?}", p.display());
                continue;
            }
        };
        let mut ctx = hayro_jpeg2000::DecoderContext::default();
        if let Err(e) = image.decode(&mut ctx) {
            eprintln!("{}: reference decode failed: {e:?}", p.display());
        }
    }
    let blocks = reference::take_recorded();
    assert!(!blocks.is_empty());
    eprintln!("{} codestreams, {} HT code-blocks", paths.len(), blocks.len());
    blocks
}

/// Block file for the speed probe: per block, u32 LE fields (width, height, missing_msbs,
/// num_passes, len_cleanup, vertically_causal, coded length) and the coded bytes.
fn serialize(blocks: &[reference::Block]) -> Vec<u8> {
    let mut out = Vec::new();
    for b in blocks {
        for v in [b.width, b.height, b.missing_msbs as usize, b.num_passes as usize, b.len_cleanup, usize::from(b.vertically_causal), b.coded.len()] {
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
        out.extend_from_slice(&b.coded);
    }
    out
}

fn deserialize(mut data: &[u8]) -> Vec<Case> {
    let mut cases = Vec::new();
    while data.len() >= 28 {
        let f: Vec<usize> = (0..7).map(|i| u32::from_le_bytes(data[4 * i..4 * i + 4].try_into().unwrap()) as usize).collect();
        let coded = data[28..28 + f[6]].to_vec();
        data = &data[28 + f[6]..];
        cases.push(Case {
            width: f[0],
            height: f[1],
            stride: f[0],
            missing_msbs: f[2] as u32,
            num_passes: f[3] as u32,
            len_cleanup: f[4],
            len_refinement: coded.len() - f[4],
            vertically_causal: f[5] != 0,
            coded,
        });
    }
    cases
}

/// Speed probe, not a check: ns per sample of both decoders on random 64×64 blocks and, with
/// `SHL_HT_BLOCKS` naming a block file from `corpus_blocks_match_reference`, on corpus blocks.
/// `cargo test --release -p shl-jpeg2000 ht_speed -- --ignored --nocapture`
#[test]
#[ignore]
fn ht_speed() {
    let mut rng = Rng(0x5DEE_CE66);
    let mut random = Vec::new();
    for k_max in [6, 10, 14, 18] {
        for density in [30u32, 70, 100] {
            let samples: Vec<u32> = (0..4096)
                .map(|_| if rng.below(100) < density { (rng.next() & 0x8000_0000) | ((1 + rng.below((1 << (k_max - 1)) - 1)) << (31 - k_max)) } else { 0 })
                .collect();
            let coded = reference::encode_block(&samples, 64, 64, 64, k_max - 1).unwrap();
            let len_cleanup = coded.len();
            random.push(Case { coded, width: 64, height: 64, stride: 64, missing_msbs: k_max - 1, num_passes: 1, len_cleanup, len_refinement: 0, vertically_causal: false });
        }
    }
    report("random 64x64 cleanup", &random);
    // The same blocks with SigProp and MagRef passes over random bytes.
    let refined: Vec<Case> = random
        .iter()
        .map(|c| {
            let mut c = c.clone();
            c.len_refinement = 1000;
            c.coded.extend((0..1000).map(|_| refinement_byte(&mut rng)));
            c.num_passes = 3;
            c
        })
        .collect();
    report("random 64x64 cleanup + SigProp + MagRef", &refined);
    if let Ok(path) = std::env::var("SHL_HT_BLOCKS") {
        let corpus = deserialize(&std::fs::read(path).unwrap());
        report("corpus blocks", &corpus);
    }
}

fn report(name: &str, cases: &[Case]) {
    use std::time::Instant;
    let samples: usize = cases.iter().map(|c| c.width * c.height).sum();
    let reps = (20_000_000 / samples.max(1)).max(3);
    let mut out = vec![0u32; 4096 + 64];
    let mut ours = Scratch::default();
    let mut theirs = reference::Scratch::default();
    // `SHL_HT_ONLY=ours` or `=reference` runs one decoder (for `perf stat`).
    let only = std::env::var("SHL_HT_ONLY").unwrap_or_default();
    let mut best = [f64::MAX; 2];
    for _ in 0..3 {
        let t = Instant::now();
        for _ in 0..if only == "reference" { 0 } else { reps } {
            for c in cases {
                let passes = BlockPasses { num_passes: c.num_passes, len_cleanup: c.len_cleanup, len_refinement: c.len_refinement };
                let _ = decode_block(&mut ours, &c.coded, &mut out, c.width, c.height, c.stride, c.missing_msbs, &passes, c.vertically_causal);
            }
        }
        best[0] = best[0].min(t.elapsed().as_secs_f64());
        let t = Instant::now();
        for _ in 0..if only == "ours" { 0 } else { reps } {
            for c in cases {
                let _ = reference::decode_block(&mut theirs, &c.coded, &mut out, c.width, c.height, c.stride, c.missing_msbs, c.num_passes, c.len_cleanup, c.len_refinement, c.vertically_causal);
            }
        }
        best[1] = best[1].min(t.elapsed().as_secs_f64());
    }
    let ns = |s: f64| s * 1e9 / (reps * samples) as f64;
    eprintln!("{name}: {} blocks, {samples} samples: ours {:.2} ns/sample, reference {:.2} ns/sample", cases.len(), ns(best[0]), ns(best[1]));
}
