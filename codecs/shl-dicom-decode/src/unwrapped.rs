//! The two encapsulated transfer syntaxes whose frames hold native pixel data (PS3.5 A.4.11 and
//! A.4.13): Encapsulated Uncompressed Explicit VR Little Endian (1.2.840.10008.1.2.1.98), where
//! each frame is the native frame bytes, and Deflated Image Frame Compression
//! (1.2.840.10008.1.2.8.1), where each frame is those bytes compressed with deflate (RFC 1951, no
//! zlib header). Each frame starts on a byte boundary, also for Bits Allocated 1, and may carry
//! one trailing pad byte.
//!
//! These are codecs with the [`shl_codec_common::DecodeFn`] signature, so the CLI splits frames,
//! decodes frame ranges and normalises exactly as for any other encapsulated syntax.

use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Photometric, Result};

use crate::pixel;

pub const TS_ENCAPSULATED_UNCOMPRESSED: &str = "1.2.840.10008.1.2.1.98";
pub const TS_DEFLATED_IMAGE_FRAME: &str = "1.2.840.10008.1.2.8.1";

/// Bytes one native frame of `info` occupies: packed bits for Bits Allocated 1, two samples per
/// pixel for the 4:2:2 photometrics.
fn stored_frame_bytes(info: &FrameInfo) -> Result<usize> {
    let samples = (info.rows as usize)
        .checked_mul(info.columns as usize)
        .and_then(|n| n.checked_mul(usize::from(info.samples_per_pixel)))
        .ok_or_else(|| DecodeError::Invalid("frame size overflows".into()))?;
    if info.bits_allocated == 1 {
        return Ok(samples.div_ceil(8));
    }
    let bytes = info.frame_bytes().ok_or_else(|| DecodeError::Invalid("frame size overflows".into()))?;
    Ok(if is_422(info) { bytes / 3 * 2 } else { bytes })
}

fn is_422(info: &FrameInfo) -> bool {
    info.samples_per_pixel == 3 && matches!(info.photometric, Photometric::YbrFull422 | Photometric::YbrPartial422)
}

/// One native frame (little endian, as stored) to codec output: bits unpacked to one byte per
/// sample, 4:2:2 expanded to three samples per pixel, planar data flagged for the CLI.
fn native_frame(stored: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let need = stored_frame_bytes(info)?;
    let Some(bytes) = stored.get(..need) else {
        return Err(DecodeError::Invalid(format!("frame holds {} bytes, the image needs {need}", stored.len())));
    };
    let data = if info.bits_allocated == 1 {
        let count = info.frame_bytes().ok_or_else(|| DecodeError::Invalid("frame size overflows".into()))?;
        pixel::unpack_bits(bytes, count).map_err(to_codec)?
    } else if is_422(info) {
        pixel::expand_ybr_422(bytes, info.bytes_per_sample()).map_err(to_codec)?
    } else {
        bytes.to_vec()
    };
    let planar = info.samples_per_pixel > 1 && info.planar_configuration == 1 && !is_422(info);
    Ok(DecodedFrame { data, planar, color: ColorOut::AsDeclared })
}

fn to_codec(e: crate::Error) -> DecodeError {
    match e {
        crate::Error::Invalid(m) => DecodeError::Invalid(m),
        crate::Error::Unsupported(m) => DecodeError::Unsupported(m),
    }
}

/// Encapsulated Uncompressed: the fragment is the native frame.
pub fn decode_encapsulated_uncompressed(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    native_frame(codestream, info)
}

/// Deflated Image Frame Compression: inflate, then as Encapsulated Uncompressed.
pub fn decode_deflated_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let need = stored_frame_bytes(info)?;
    // A frame inflates to its native size, plus at most a pad byte; more is not this image.
    let limit = need.saturating_add(2);
    let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(codestream, limit)
        .map_err(|e| DecodeError::Invalid(format!("frame does not inflate to {need} bytes: {:?}", e.status)))?;
    native_frame(&inflated, info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(photometric: Photometric, spp: u16, ba: u16, pc: u16) -> FrameInfo {
        FrameInfo {
            rows: 2,
            columns: 4,
            samples_per_pixel: spp,
            bits_allocated: ba,
            bits_stored: ba,
            pixel_representation: 0,
            photometric,
            planar_configuration: pc,
            transfer_syntax: TS_DEFLATED_IMAGE_FRAME.into(),
        }
    }

    #[test]
    fn bits_unpack_per_frame() {
        let f = decode_encapsulated_uncompressed(&[0b1000_0001, 0x00], &info(Photometric::Monochrome2, 1, 1, 0)).unwrap();
        assert_eq!(f.data, [1, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn deflated_roundtrip_and_short_frame() {
        let raw: Vec<u8> = (0..8u8).collect();
        let z = miniz_oxide::deflate::compress_to_vec(&raw, 6);
        let f = decode_deflated_frame(&z, &info(Photometric::Monochrome2, 1, 8, 0)).unwrap();
        assert_eq!(f.data, raw);
        assert!(decode_encapsulated_uncompressed(&raw[..7], &info(Photometric::Monochrome2, 1, 8, 0)).is_err());
        // Inflating to far more than the frame is refused without allocating it.
        let big = miniz_oxide::deflate::compress_to_vec(&vec![0u8; 1 << 20], 6);
        assert!(decode_deflated_frame(&big, &info(Photometric::Monochrome2, 1, 8, 0)).is_err());
    }

    #[test]
    fn planar_is_flagged() {
        let f = decode_encapsulated_uncompressed(&[0; 24], &info(Photometric::Rgb, 3, 8, 1)).unwrap();
        assert!(f.planar);
    }
}
