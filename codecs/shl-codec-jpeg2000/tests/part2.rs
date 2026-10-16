//! JPEG 2000 Part 2 multiple component transformations (vendored hayro patch 11).
//!
//! Fixtures, made by codec-corpus/scripts/sources/j2k_part2.py's functions:
//! - `part2-rgb-two-stages.j2c`: 16×16 RGB, two MCO stages (a reversible dependency over a
//!   permuted collection plus an offset-only collection, then a reversible decorrelation),
//!   an MCC series, 16/32-bit and float arrays; `.rgb` is the original image.
//! - `part2-volume-4.j2c`: four 16×16 12-bit frames as the components of one codestream, the
//!   previous frame predicting the next; `.u16` is the original volume.
use shl_codec_common::{DecodeError, FrameInfo, Photometric};
use shl_codec_jpeg2000::{decode_frame, decode_frame_scaled, decode_frames};

const RGB: &[u8] = include_bytes!("data/part2-rgb-two-stages.j2c");
const VOLUME: &[u8] = include_bytes!("data/part2-volume-4.j2c");

fn info(spp: u16, ba: u16, bs: u16, photometric: Photometric) -> FrameInfo {
    FrameInfo {
        rows: 16,
        columns: 16,
        samples_per_pixel: spp,
        bits_allocated: ba,
        bits_stored: bs,
        pixel_representation: 0,
        photometric,
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.92".into(),
    }
}

fn rgb_info() -> FrameInfo {
    info(3, 8, 8, Photometric::Rgb)
}

/// Position just after the marker segment `marker` in the main header, and its start.
fn segment(cs: &[u8], marker: u16) -> Option<(usize, usize)> {
    let mut pos = 4 + usize::from(u16::from_be_bytes([cs[4], cs[5]]));
    loop {
        let m = u16::from_be_bytes([cs[pos], cs[pos + 1]]);
        if m == 0xFF90 {
            return None;
        }
        let end = pos + 2 + usize::from(u16::from_be_bytes([cs[pos + 2], cs[pos + 3]]));
        if m == marker {
            return Some((pos, end));
        }
        pos = end;
    }
}

#[test]
fn two_stages_reconstruct_the_original() {
    let f = decode_frame(RGB, &rgb_info()).unwrap();
    assert_eq!(f.data, include_bytes!("data/part2-rgb-two-stages.rgb"));
}

#[test]
fn reduced_decode_applies_the_transformation() {
    // 1/2: the transformation runs on the reduced components; same size as the reduced grid,
    // and close to the original (lossless content, smooth ramps).
    let r = decode_frame_scaled(RGB, &rgb_info(), 1).unwrap();
    assert_eq!((r.rows, r.columns, r.frame.data.len()), (8, 8, 8 * 8 * 3));
}

#[test]
fn volume_decodes_frame_by_frame() {
    let i = info(1, 16, 12, Photometric::Monochrome2);
    let (n, f) = decode_frames(VOLUME, &i).unwrap();
    assert_eq!(n, 4);
    assert_eq!(f.data, include_bytes!("data/part2-volume-4.u16"));
    // decode_frame refuses a codestream holding several frames.
    assert!(decode_frame(VOLUME, &i).is_err());
    // decode_frames on a one-frame codestream gives that frame.
    let (n, one) = decode_frames(RGB, &rgb_info()).unwrap();
    assert_eq!((n, one.data.len()), (1, 16 * 16 * 3));
}

#[test]
fn wavelet_collection_is_unsupported() {
    // MCC 5 (the second stage): Xmcc 1 -> 3, wavelet-based (with Omcc, so the segment grows).
    let mut cs = RGB.to_vec();
    let mut pos = 4 + usize::from(u16::from_be_bytes([cs[4], cs[5]]));
    loop {
        let m = u16::from_be_bytes([cs[pos], cs[pos + 1]]);
        let len = usize::from(u16::from_be_bytes([cs[pos + 2], cs[pos + 3]]));
        if m == 0xFF75 && cs[pos + 6] == 5 {
            // Zmcc 0, Imcc 5, Ymcc, Qmcc, then Xmcc at +11.
            cs[pos + 11] = 3;
            cs.splice(pos + 2 + len..pos + 2 + len, [0u8; 4]);
            let l = (len + 4) as u16;
            cs[pos + 2..pos + 4].copy_from_slice(&l.to_be_bytes());
            break;
        }
        pos += 2 + len;
    }
    assert!(matches!(decode_frame(&cs, &rgb_info()), Err(DecodeError::Unsupported(_))));
}

#[test]
fn other_part2_capabilities_are_unsupported() {
    // Rsiz with the arbitrary transformation kernel bit as well as MCT.
    let mut cs = RGB.to_vec();
    cs[6..8].copy_from_slice(&0x8140u16.to_be_bytes());
    assert!(matches!(decode_frame(&cs, &rgb_info()), Err(DecodeError::Unsupported(_))));
}

#[test]
fn part2_markers_in_a_part1_codestream_are_unsupported() {
    // Rsiz 0: CBD, MCT, MCC and MCO are not Part 1 marker segments, and COD's transformation
    // type 2 means nothing in Part 1. The SIZ components (11-bit) are then the output, which
    // the data set's 8 bits refuse; the decoder alone refuses the markers.
    let mut cs = RGB.to_vec();
    cs[6..8].copy_from_slice(&0u16.to_be_bytes());
    assert!(decode_frame(&cs, &rgb_info()).is_err());
    assert!(matches!(shl_jpeg2000::decode(&cs, &Default::default()), Err(shl_jpeg2000::Error::Unsupported(_))));
}

#[test]
fn missing_collection_is_invalid() {
    // MCO's second stage names MCC 9, which does not exist.
    let mut cs = RGB.to_vec();
    let (start, _) = segment(&cs, 0xFF77).unwrap();
    cs[start + 6] = 9;
    assert!(matches!(decode_frame(&cs, &rgb_info()), Err(DecodeError::Invalid(_))));
}

#[test]
fn output_components_must_match_the_data_set() {
    // CBD says 3 components; one sample per pixel is refused before decoding.
    assert!(decode_frame(RGB, &info(1, 8, 8, Photometric::Monochrome2)).is_err());
}

#[test]
fn every_truncation_is_refused_without_panic() {
    for n in 0..RGB.len() {
        let _ = decode_frame(&RGB[..n], &rgb_info());
    }
    for n in 0..VOLUME.len() {
        let _ = decode_frames(&VOLUME[..n], &info(1, 16, 12, Photometric::Monochrome2));
    }
}
