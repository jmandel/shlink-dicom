//! Regression tests for decoding bugs and quirks (FORMAT.md, Rulings and STATUS).
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
/// under LRCP, where a packet order must skip the resolutions a component lacks. Any result
/// but a panic is fine for this mutated stream.
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
/// 0). The bit is skipped whatever its value, as OpenJPEG does; treating it as an error
/// drops the rest of the tile (max |diff| 89 on this lossless frame).
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

/// RareCyte slides use 33 quality layers (COD allows up to 65,535).
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

/// Region-of-interest coding is not implemented, and skipping RGN would decode wrong
/// samples, so it is refused as unsupported.
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

/// Fuzz findings in the reduced-resolution path, from the `decode_scaled` target: an empty
/// tile at the reduced level, a tile-part COD with fewer levels than the reduction, and
/// subsampled components in a reduced tile. Each input is the target's: one selector byte,
/// then a codestream; the FrameInfo is rebuilt as the target builds it. Any result but a
/// panic is fine; a decoded frame must have the reduced size.
#[test]
fn reduced_decode_fuzz_findings_do_not_panic() {
    fn siz_dims(cs: &[u8]) -> Option<(u32, u32, u16)> {
        let i = cs.windows(2).position(|w| w == [0xFF, 0x51])? + 2;
        let r32 = |k: usize| -> Option<u32> { Some(u32::from_be_bytes(cs.get(i + k..i + k + 4)?.try_into().ok()?)) };
        let (x, y, xo, yo) = (r32(4)?, r32(8)?, r32(12)?, r32(16)?);
        let c = u16::from_be_bytes(cs.get(i + 36..i + 38)?.try_into().ok()?);
        Some((y.checked_sub(yo)?, x.checked_sub(xo)?, c))
    }
    let inputs: [&[u8]; 4] = [
        include_bytes!("data/reduced-fuzz-1.bin"),
        include_bytes!("data/reduced-fuzz-2.bin"),
        include_bytes!("data/reduced-fuzz-3.bin"),
        include_bytes!("data/reduced-fuzz-4.bin"),
    ];
    for data in inputs {
        let (&sel, cs) = data.split_first().unwrap();
        let (mut rows, mut cols, mut spp) = (64u32, 64u32, 1u16);
        if sel & 1 == 0 {
            if let Some((r, c, s)) = siz_dims(cs) {
                if u64::from(r).saturating_mul(u64::from(c)).saturating_mul(u64::from(s)) <= 1 << 20 {
                    (rows, cols, spp) = (r, c, s);
                }
            }
        }
        let info = FrameInfo {
            rows,
            columns: cols,
            samples_per_pixel: spp,
            bits_allocated: [16, 8, 32, 16][usize::from((sel >> 1) & 3)],
            bits_stored: 12,
            pixel_representation: u16::from((sel >> 3) & 1),
            photometric: [Photometric::Monochrome2, Photometric::Rgb, Photometric::YbrRct, Photometric::Monochrome1]
                [usize::from((sel >> 4) & 3)],
            planar_configuration: 0,
            transfer_syntax: String::new(),
        };
        let s = 1 + (sel >> 6);
        if let Ok(d) = shl_codec_jpeg2000::decode_frame_scaled(cs, &info, s) {
            let n = 1u32 << s;
            assert_eq!((d.rows, d.columns), (rows.div_ceil(n), cols.div_ceil(n)));
            let small = FrameInfo { rows: d.rows, columns: d.columns, ..info.clone() };
            assert_eq!(Some(d.frame.data.len()), small.frame_bytes());
        }
    }
}

/// Fuzz finding: a Part 1 codestream with 4:2:2 chroma decoded by `decode_frames` as a volume
/// of one-component frames. The chroma frames are subsampled outside the sYCC layout and must
/// be refused, not packed as if full size.
#[test]
fn subsampled_components_as_frames_are_refused() {
    let cs = include_bytes!("data/frames-subsampled-fuzz.j2c");
    let info = info(50, 240, 1, 8, Photometric::Monochrome2);
    let info = FrameInfo { pixel_representation: 1, ..info };
    assert!(shl_codec_jpeg2000::decode_frames(cs, &info).is_err());
}
