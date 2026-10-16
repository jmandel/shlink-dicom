//! HTJ2K (1.2.840.10008.1.2.4.201/.202/.203) decoder.
//! See codec-corpus/formats/htj2k/FORMAT.md.
//!
//! HTJ2K codestreams are JPEG 2000 codestreams with HT code-blocks (ITU-T T.814), so this
//! crate calls `shl-codec-jpeg2000`, whose decoder (`shl-jpeg2000`) reads HT, Part 1 and
//! MIXED code-blocks alike. The header checks and output packing are
//! `shl_codec_jpeg2000::prep`.
#![forbid(unsafe_code)]

use shl_codec_common::{DecodedFrame, DecodedScaled, FrameInfo, Result};

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    shl_codec_jpeg2000::decode_frame(codestream, info)
}

/// Decode one frame at 1/2^`scale_log2` size (`shl_codec_common::DecodeScaledFn`),
/// discarding the highest resolution levels (see `shl_codec_jpeg2000::decode_frame_scaled`
/// for what it refuses).
pub fn decode_frame_scaled(codestream: &[u8], info: &FrameInfo, scale_log2: u8) -> Result<DecodedScaled> {
    shl_codec_jpeg2000::decode_frame_scaled(codestream, info, scale_log2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::{DecodeError, Photometric};

    fn info(rows: u32, cols: u32) -> FrameInfo {
        FrameInfo {
            rows,
            columns: cols,
            samples_per_pixel: 1,
            bits_allocated: 16,
            bits_stored: 16,
            pixel_representation: 0,
            photometric: Photometric::Monochrome2,
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.201".into(),
        }
    }

    #[test]
    fn garbage_is_invalid() {
        for data in [&b""[..], b"\xFF\x4F", b"\x00\x00\x00\x0CjP  \r\n\x87\n", b"hello world"] {
            assert!(matches!(decode_frame(data, &info(1, 1)), Err(DecodeError::Invalid(_))));
        }
    }

    /// A SIZ far larger than the data set must be refused before anything is allocated.
    #[test]
    fn huge_siz_is_refused() {
        let mut cs = vec![0xFF, 0x4F, 0xFF, 0x51, 0, 41, 0x40, 0];
        for x in [0xFEFF_DDE0u32, 1024, 0, 0, 0xFEFF_DDE0, 1024, 0, 0] {
            cs.extend_from_slice(&x.to_be_bytes());
        }
        cs.extend_from_slice(&[0, 1, 15, 1, 1]);
        cs.extend_from_slice(&[0xFF, 0x52, 0, 12, 0, 0, 0, 1, 0, 5, 4, 4, 0x40, 1]);
        cs.extend_from_slice(&[0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 0, 0, 1, 0xFF, 0x93, 0xFF, 0xD9]);
        assert!(matches!(decode_frame(&cs, &info(1024, 256)), Err(DecodeError::Invalid(_))));
    }
}
