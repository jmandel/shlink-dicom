//! Regression tests for bugs found in phase 2 (FORMAT.md, Rulings and STATUS).
//!
//! The corpus-backed tests use frames written by `scripts/extract_frames.py` and the oracle
//! arrays from `scripts/oracle.py`; they are skipped, with a note, when those files are absent.
use std::path::{Path, PathBuf};

use shl_codec_common::{ColorOut, DecodeError, FrameInfo, Photometric};
use shl_codec_jpeg2000::decode_frame;

fn info(rows: u32, cols: u32, spp: u16, ba: u16, photometric: Photometric) -> FrameInfo {
    FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated: ba,
        bits_stored: ba,
        pixel_representation: 0,
        photometric,
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.90".into(),
    }
}

/// Fuzz finding: components with different decomposition levels (COC in a tile-part header)
/// under LRCP made hayro's progression iterator build a resolution the component lacks, and
/// panic. Vendored hayro patch 2. Any result but a panic is fine for this mutated stream.
#[test]
fn lrcp_with_fewer_levels_in_one_component_does_not_panic() {
    let cs = include_bytes!("data/lrcp-coc-fewer-levels.j2c");
    let _ = decode_frame(cs, &info(100, 100, 3, 8, Photometric::Rgb));
}

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/jpeg2000")
}

/// Frame `k` of an oracle .npy (C order, little-endian, frames first).
fn oracle_frame(case: &str, k: usize, frame_bytes: usize) -> Option<Vec<u8>> {
    let npy = std::fs::read(corpus().join("oracle").join(format!("{case}.npy"))).ok()?;
    let header_len = u16::from_le_bytes([npy[8], npy[9]]) as usize;
    let data = &npy[10 + header_len..];
    data.get(k * frame_bytes..(k + 1) * frame_bytes).map(<[u8]>::to_vec)
}

fn frame(case: &str, k: usize) -> Option<Vec<u8>> {
    std::fs::read(corpus().join("frames").join(case).join(format!("frame-{k}.bin"))).ok()
}

/// A packet header in this Aperio frame has a 1 in the bit stuffed after 0xFF (B.10.1 says
/// 0). Hayro rejected it and silently dropped the rest of the tile, giving max |diff| 89 on
/// a lossless frame. Vendored hayro patch 4 skips the bit as OpenJPEG does.
#[test]
fn nonzero_stuffed_bit_in_packet_header() {
    let case = "idc-j2kr-rct-u8of8-p0-mf-sm-leicabiosy-d680304a";
    let i = info(240, 240, 3, 8, Photometric::YbrRct);
    let (Some(cs), Some(want)) = (frame(case, 75), oracle_frame(case, 75, 240 * 240 * 3)) else {
        eprintln!("skipped: {case} frame 75 or its oracle not extracted");
        return;
    };
    let got = decode_frame(&cs, &i).unwrap();
    assert_eq!(got.color, ColorOut::Rgb);
    assert!(got.data == want, "frame 75 differs from the lossless oracle");
}

/// RareCyte slides use 33 quality layers; hayro capped layers at 32 and failed to parse COD.
/// Vendored hayro patch 1.
#[test]
fn thirty_three_quality_layers() {
    let case = "idc-j2kr-mono2-u16of16-mf-sm-rarecyte-1e744ed2";
    let i = info(1024, 1024, 1, 16, Photometric::Monochrome2);
    let (Some(cs), Some(want)) = (frame(case, 0), oracle_frame(case, 0, 1024 * 1024 * 2)) else {
        eprintln!("skipped: {case} frame 0 or its oracle not extracted");
        return;
    };
    let got = decode_frame(&cs, &i).unwrap();
    assert!(got.data == want, "frame 0 differs from the lossless oracle");
}

/// Region-of-interest coding is not implemented in hayro 0.4.1, which used to skip RGN and
/// decode wrong samples. Vendored hayro patch 3 refuses it as unsupported.
#[test]
fn rgn_is_unsupported() {
    // SOC, SIZ 4x4 one 8-bit component, COD, QCD (no quantisation, 5 levels), RGN, SOT.
    let mut cs = vec![0xFF, 0x4F, 0xFF, 0x51, 0, 41, 0, 0];
    for x in [4u32, 4, 0, 0, 4, 4, 0, 0] {
        cs.extend_from_slice(&x.to_be_bytes());
    }
    cs.extend_from_slice(&[0, 1, 7, 1, 1]);
    cs.extend_from_slice(&[0xFF, 0x52, 0, 12, 0, 0, 0, 1, 0, 2, 4, 4, 0, 1]);
    cs.extend_from_slice(&[0xFF, 0x5C, 0, 6, 0x40, 0x40, 0x48, 0x48]);
    cs.extend_from_slice(&[0xFF, 0x5E, 0, 5, 0, 0, 3]);
    cs.extend_from_slice(&[0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 14, 0, 1, 0xFF, 0x93, 0x00, 0x00, 0xFF, 0xD9]);
    let r = decode_frame(&cs, &info(4, 4, 1, 8, Photometric::Monochrome2));
    assert!(matches!(r, Err(DecodeError::Unsupported(_))), "{r:?}");
}
