//! The HT block decoder against `tests/data/ht-golden.bin`: 209 calls (random blocks of every
//! size class and precision with SigProp and MagRef bytes, damaged blocks, random segments),
//! each with the result of an independent decoder (ndic-htj2k 0.2.5's block decoder, a port of
//! OpenJPH's): whether it decoded, and a hash of every word of the output buffer, which starts
//! filled with 0xDEADBEEF and has padding between rows and after the last.
use shl_jpeg2000::ht::{decode_block, BlockPasses, Scratch};

#[test]
fn matches_golden_results() {
    let data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/ht-golden.bin")).unwrap();
    assert_eq!(&data[..4], b"HTG1");
    let mut at = 8;
    let mut take = |n: usize| {
        let s = &data[at..at + n];
        at += n;
        s
    };
    let count = u32::from_le_bytes(data[4..8].try_into().unwrap());
    let mut scratch = Scratch::default();
    let mut decoded = 0;
    for i in 0..count {
        let u16_ = |b: &[u8]| usize::from(u16::from_le_bytes([b[0], b[1]]));
        let u32_ = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        let (width, height, stride) = (u16_(take(2)), u16_(take(2)), u16_(take(2)));
        let (missing_msbs, num_passes) = (u32::from(take(1)[0]), u32::from(take(1)[0]));
        let (len_cleanup, len_refinement) = (u32_(take(4)) as usize, u32_(take(4)) as usize);
        let (causal, ok) = (take(1)[0] != 0, take(1)[0] != 0);
        let hash = u64::from_le_bytes(take(8).try_into().unwrap());
        let n = u32_(take(4)) as usize;
        let coded = take(n).to_vec();
        let mut out = vec![0xDEAD_BEEFu32; (height - 1) * stride + width + 3];
        let r = decode_block(&mut scratch, &coded, &mut out, width, height, stride, missing_msbs, &BlockPasses { num_passes, len_cleanup, len_refinement }, causal);
        assert_eq!(r.is_ok(), ok, "case {i}: {width}x{height} passes {num_passes}: {r:?}");
        if ok {
            let h = out.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &w| (h ^ u64::from(w)).wrapping_mul(0x100_0000_01b3));
            assert_eq!(h, hash, "case {i}: {width}x{height} stride {stride} passes {num_passes}");
            decoded += 1;
        }
    }
    assert_eq!(decoded, 180);
}
