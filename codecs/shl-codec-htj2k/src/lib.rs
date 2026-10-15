//! HTJ2K (1.2.840.10008.1.2.4.201/.202/.203) decoder.
//! Owned by the htj2k format agent; see codec-corpus/formats/htj2k/FORMAT.md.
//!
//! Two decoders, both vendored:
//! - **hayro** (in `shl-codec-jpeg2000`), with an HT block decoder added (its vendor patch
//!   5). This is the fast path, and it decodes almost every HTJ2K frame: HT-only or
//!   HT-declared code-blocks, one HT set per code-block, any number of layers.
//! - **oxideav-jpeg2000** 0.0.17 (vendor/README.md), which also decodes MIXED code-blocks
//!   (HT and Part 1 in one tile-component) and multiple HT sets. Any frame hayro does not
//!   decode, for whatever reason, goes to oxideav, so nothing that decoded before this
//!   change fails now.
//!
//! Every corpus frame decodes identically both ways (`tests/cross_check.rs`).
//!
//! The header checks and output packing are `shl_codec_jpeg2000::prep`, shared with the
//! JPEG 2000 wrapper: both decoders allocate from SIZ before decoding, so a SIZ that
//! disagrees with the data set is refused first. Neither wrapper dispatches on CAP.
#![forbid(unsafe_code)]

use shl_codec_common::{DecodeError, DecodedFrame, FrameInfo, Result};
use shl_codec_jpeg2000::prep;

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    shl_codec_jpeg2000::decode_frame_high_throughput(codestream, info)
        .or_else(|_| decode_frame_oxideav(codestream, info))
}

/// Decode with hayro's HT path only (no fallback). For tests and benchmarks.
pub fn decode_frame_hayro(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    shl_codec_jpeg2000::decode_frame_high_throughput(codestream, info)
}

/// Decode with oxideav only. The fallback, and the cross-check in tests.
pub fn decode_frame_oxideav(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let prep = prep::prepare(codestream, info)?;
    let image = oxideav_jpeg2000::decode_j2k(prep.codestream).map_err(map_err)?;
    if image.width != info.columns
        || image.height != info.rows
        || image.components.len() != prep.header.components.len()
        || image.components.iter().enumerate().any(|(c, comp)| {
            let (cw, ch) = prep.component_size(c);
            comp.width != cw || comp.height != ch || comp.samples.len() < (cw as usize) * (ch as usize)
        })
    {
        return Err(DecodeError::Invalid("decoder output disagrees with SIZ".into()));
    }
    // oxideav returns signed components as signed values, with RCT/ICT already undone, and
    // each component on its own (possibly subsampled) grid.
    let planes: Vec<(&[i32], usize)> =
        image.components.iter().map(|c| (c.samples.as_slice(), c.width as usize)).collect();
    prep::pack(info, &prep, |c, cx, cy| {
        let (plane, cw) = planes[c];
        plane[cy * cw + cx]
    })
}

fn map_err(e: oxideav_jpeg2000::Error) -> DecodeError {
    use oxideav_jpeg2000::Error as E;
    match e {
        E::Unsupported(_) | E::NotImplemented => DecodeError::Unsupported(format!("HTJ2K: {e}")),
        _ => DecodeError::Invalid(format!("HTJ2K: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::Photometric;

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

    /// A SIZ far larger than the data set must be refused before oxideav allocates.
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
