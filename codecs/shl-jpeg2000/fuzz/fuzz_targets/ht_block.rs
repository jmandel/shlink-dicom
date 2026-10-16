//! The HT block decoder on arbitrary segments and arguments: it must not panic, and it must
//! not write outside the block.
#![no_main]

use libfuzzer_sys::fuzz_target;
use shl_jpeg2000::ht::{decode_block, BlockPasses, Scratch};

fuzz_target!(|data: &[u8]| {
    // 6 bytes of arguments, then the coded bytes.
    let Some((args, coded)) = data.split_first_chunk::<6>() else { return };
    let width = 1 + usize::from(args[0]) % 64 + if args[5] & 0x80 != 0 { 960 } else { 0 };
    let height = (1 + usize::from(args[1]) % 64).min(4096 / width);
    let missing_msbs = u32::from(args[2] % 32);
    let num_passes = u32::from(args[3] % 5);
    let split = usize::from(args[4]) | usize::from(args[5] & 0x7) << 8;
    let len_cleanup = split.min(coded.len());
    let len_refinement = if args[5] & 0x8 != 0 { coded.len() - len_cleanup } else { 0 };
    let vertically_causal = args[5] & 0x10 != 0;
    let stride = width + usize::from(args[5] >> 5 & 3);

    let len = (height - 1) * stride + width;
    let mut out = vec![0x5A5A_5A5Au32; len + 3];
    let passes = BlockPasses { num_passes, len_cleanup, len_refinement };
    let _ = decode_block(&mut Scratch::default(), coded, &mut out, width, height, stride, missing_msbs, &passes, vertically_causal);
    for (i, &w) in out.iter().enumerate() {
        if i % stride >= width || i / stride >= height {
            assert_eq!(w, 0x5A5A_5A5A, "word {i} outside the block was written");
        }
    }
});
