//! Unit tests of the HT block decoder that need no reference. `tests/ht_golden.rs` compares
//! output words with an independent decoder's.

use super::{decode_block, BlockPasses, Scratch};

#[test]
fn lookup_tables_are_complete() {
    for t in [&super::tables::CXT_LOOKUP_0, &super::tables::CXT_LOOKUP_1] {
        assert!(t.iter().all(|&e| (e >> 5) & 7 != 0));
    }
}

/// Bad arguments are errors.
#[test]
fn argument_errors() {
    let coded = [0u8, 0x02, 0x00, 0x00];
    let mut out = vec![0u32; 2048];
    let mut s = Scratch::default();
    let p = |num_passes, len_cleanup, len_refinement| BlockPasses { num_passes, len_cleanup, len_refinement };
    // Too wide, too large, too many missing planes, a cleanup segment of 1 byte, segments
    // longer than the data, four passes.
    assert!(decode_block(&mut s, &coded, &mut out, 1025, 1, 1025, 5, &p(1, 3, 0), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 65, 64, 65, 5, &p(1, 3, 0), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 30, &p(1, 3, 0), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 5, &p(1, 1, 0), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 5, &p(1, 5, 0), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 5, &p(2, 3, 2), false).is_err());
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 5, &p(4, 3, 1), false).is_err());
    // The same block with sane arguments decodes.
    assert!(decode_block(&mut s, &coded, &mut out, 4, 4, 4, 5, &p(1, 3, 0), false).is_ok());
}

/// Segments of random bytes with a plausible Scup, at many sizes: no panic, and nothing
/// written outside the block.
#[test]
fn random_segments_stay_inside_the_block() {
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut next = || {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 32) as u32
    };
    let mut s = Scratch::default();
    for case in 0..5_000u32 {
        let (width, height) = [(1, 1), (3, 5), (4, 4), (13, 11), (33, 31), (64, 64), (1024, 4), (4, 1024)][case as usize % 8];
        let stride = width + (next() % 3) as usize;
        let lcup = 2 + (next() % 300) as usize;
        let lref = (next() % 40) as usize;
        let mut coded: Vec<u8> = (0..lcup + lref).map(|_| next() as u8).collect();
        let scup = 2 + (next() as usize % (lcup.min(4079) - 1));
        coded[lcup - 1] = (scup >> 4) as u8;
        coded[lcup - 2] = (coded[lcup - 2] & 0xF0) | (scup & 0xF) as u8;
        let mut out = vec![0x5A5A_5A5Au32; (height - 1) * stride + width + 3];
        let passes = BlockPasses { num_passes: 1 + next() % 3, len_cleanup: lcup, len_refinement: lref };
        let _ = decode_block(&mut s, &coded, &mut out, width, height, stride, 10 + next() % 20, &passes, next() % 2 == 0);
        for (i, &w) in out.iter().enumerate() {
            let (x, y) = (i % stride, i / stride);
            if x >= width || y >= height {
                assert_eq!(w, 0x5A5A_5A5A, "case {case}: word {i} outside the block was written");
            }
        }
    }
}
