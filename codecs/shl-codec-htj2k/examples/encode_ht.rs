//! Writes HTJ2K codestreams that `ojph_compress` cannot, with the vendored oxideav encoder
//! (Kakadu is not installed). Used by codec-corpus/formats/htj2k/extra/gen_oxideav.py.
//!
//!     encode_ht MODE IN.raw OUT.j2c WIDTH HEIGHT COMPONENTS BITS
//!
//! MODE is one of:
//! - `mixed`: the T.814 MIXED set: each code-block is HT or Part 1 (MQ);
//! - `refine`: HT code-blocks with SigProp and MagRef passes (three passes per block where
//!   that stays lossless; `ojph_compress` writes the cleanup pass only);
//! - `layers`: HT code-blocks in three quality layers, one HT set per layer (MULTIHT), with
//!   placeholder passes.
//!
//! IN.raw holds unsigned samples, interleaved by pixel: one byte each when BITS <= 8,
//! otherwise two bytes little-endian. The coding is lossless (5/3), RPCL, five decomposition
//! levels, with RCT for three components.
use oxideav_jpeg2000::{encode::encode_j2k_u16, EncodeOptions, ProgressionOrder};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 8 {
        eprintln!("usage: encode_ht mixed|refine|layers IN.raw OUT.j2c WIDTH HEIGHT COMPONENTS BITS");
        std::process::exit(2);
    }
    let raw = std::fs::read(&a[2]).expect("read input");
    let n = |i: usize| a[i].parse::<usize>().expect("number");
    let (w, h, comps, bits) = (n(4), n(5), n(6), n(7));
    let bytes = if bits <= 8 { 1 } else { 2 };
    assert_eq!(raw.len(), w * h * comps * bytes, "input size");
    let planes: Vec<Vec<u16>> = (0..comps)
        .map(|c| {
            (0..w * h)
                .map(|i| {
                    let k = (i * comps + c) * bytes;
                    if bytes == 1 { u16::from(raw[k]) } else { u16::from_le_bytes([raw[k], raw[k + 1]]) }
                })
                .collect()
        })
        .collect();
    let refs: Vec<&[u16]> = planes.iter().map(|p| p.as_slice()).collect();
    let mut opts = EncodeOptions::default();
    opts.decomposition_levels = 5;
    opts.mct = Some(comps == 3);
    opts.progression = ProgressionOrder::Rpcl;
    match a[1].as_str() {
        "mixed" => opts.ht_mixed = true,
        "refine" => {
            opts.high_throughput = true;
            opts.ht_refinement = true;
        }
        "layers" => {
            opts.high_throughput = true;
            opts.layers = 3;
        }
        m => panic!("unknown mode {m}"),
    }
    let cs = encode_j2k_u16(&refs, w as u32, h as u32, bits as u8, &opts).expect("encode");
    std::fs::write(&a[3], cs).expect("write output");
}
