//! The HT block decoder on arbitrary segments and arguments: it must not panic, and it must
//! agree with the vendored decoder it replaces (success, and every output word).
#![no_main]

use hayro_jpeg2000::ht_reference as reference;
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
    let mut ours = vec![0x5A5A_5A5Au32; len];
    let mut theirs = ours.clone();
    let passes = BlockPasses { num_passes, len_cleanup, len_refinement };
    let a = decode_block(&mut Scratch::default(), coded, &mut ours, width, height, stride, missing_msbs, &passes, vertically_causal);
    let b = reference::decode_block(
        &mut reference::Scratch::default(),
        coded,
        &mut theirs,
        width,
        height,
        stride,
        missing_msbs,
        num_passes,
        len_cleanup,
        len_refinement,
        vertically_causal,
    );
    assert_eq!(a.is_ok(), b.is_ok(), "ours {a:?}, reference {b:?}");
    if a.is_ok() {
        assert!(ours == theirs, "output differs");
    }
});
