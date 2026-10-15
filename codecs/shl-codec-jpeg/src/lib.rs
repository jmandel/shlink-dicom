//! JPEG decoder for DICOM: every process of ITU-T T.81. Baseline and extended DCT (8 and 12-bit),
//! spectral selection and full progression, lossless (selection values 1–7, 2–16 bits, point
//! transform), Huffman or arithmetic coding, and hierarchical images (DHP/EXP, differential frames).
//!
//! Owned by the jpeg format agent; see codec-corpus/AGENTS.md and codec-corpus/formats/jpeg-*/.
//! The DCT path reproduces IJG libjpeg's default decoder (`jidctint` integer IDCT, fancy upsampling,
//! fixed-point YCbCr→RGB tables) so output matches dcmtk, gdcm and libjpeg-turbo. Sequential Huffman
//! frames are transformed block by block as they are decoded (`dct`); progressive, arithmetic and
//! hierarchical frames first fill a coefficient buffer (`coef`, `phuff`, `arith`, `hier`).
// Unsafe code is confined to `simd.rs` (the AVX2 dispatch call); see its module docs.
#![deny(unsafe_code)]

mod arith;
mod bits;
mod coef;
mod dct;
mod hier;
mod huffman;
mod idct;
mod lossless;
mod markers;
mod out;
mod phuff;
mod simd;

/// The corpus loader shared with `tests/` (used by `simd::tests`).
#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod test_common;

use shl_codec_common::{scaled_extent, DecodeError, DecodedFrame, DecodedScaled, FrameInfo, Result};

pub(crate) fn invalid(m: &str) -> DecodeError {
    DecodeError::Invalid(m.to_string())
}

pub(crate) fn unsupported(m: &str) -> DecodeError {
    DecodeError::Unsupported(m.to_string())
}

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let max_bytes = info.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    if info.rows == 0 || info.columns == 0 {
        return Err(invalid("zero rows or columns"));
    }
    if !matches!(info.bits_allocated, 8 | 16 | 32) {
        return Err(unsupported("JPEG output needs Bits Allocated 8, 16 or 32"));
    }
    let mut image = markers::decode(codestream, info, false, 0)?;
    if image.retry_cornell {
        // A lossless stream that used SSSS = 16 and then hit undecodable codes: probably the buggy
        // Cornell 16-bit encoder, which wrote 16 extra bits after SSSS = 16. Keep the workaround's
        // decode only if it is clean (ruling in jpeg-lossless FORMAT.md, `ext-gdcm-MITRA_CORNELL`).
        if let Ok(alt) = markers::decode(codestream, info, true, 0) {
            if alt.bad_codes == 0 {
                image = alt;
            }
        }
    }
    image.into_frame(info, max_bytes)
}

/// Decode one frame at 1/2^`scale_log2` size in each direction (`shl_codec_common::DecodeScaledFn`),
/// as libjpeg-turbo does with `scale_num = 1, scale_denom = 2^scale_log2`: the reduced inverse
/// DCTs of `jidctred.c` (4×4, 2×2, 1×1 from each 8×8 block), with subsampled components given a
/// larger IDCT where that replaces upsampling, then libjpeg-turbo's upsampling at the reduced
/// size (no fancy upsampling at 1/8) and colour conversion. The result is ceil(rows / 2^s) ×
/// ceil(columns / 2^s).
///
/// `scale_log2` 0 is [`decode_frame`]. Scales above 1/8 (`scale_log2` > 3) and lossless JPEG
/// return `Unsupported`, so the caller falls back to a full decode and its own downsample.
pub fn decode_frame_scaled(codestream: &[u8], info: &FrameInfo, scale_log2: u8) -> Result<DecodedScaled> {
    if scale_log2 == 0 {
        let frame = decode_frame(codestream, info)?;
        return Ok(DecodedScaled { frame, rows: info.rows, columns: info.columns });
    }
    if scale_log2 > 3 {
        return Err(unsupported("JPEG reduces by at most 1/8 (scale_log2 3)"));
    }
    info.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    if info.rows == 0 || info.columns == 0 {
        return Err(invalid("zero rows or columns"));
    }
    if !matches!(info.bits_allocated, 8 | 16 | 32) {
        return Err(unsupported("JPEG output needs Bits Allocated 8, 16 or 32"));
    }
    let image = markers::decode(codestream, info, false, scale_log2)?;
    let (rows, columns) = (scaled_extent(info.rows, scale_log2), scaled_extent(info.columns, scale_log2));
    let scaled = FrameInfo { rows, columns, ..info.clone() };
    let max_bytes = scaled.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    let frame = image.into_frame(&scaled, max_bytes)?;
    Ok(DecodedScaled { frame, rows, columns })
}

/// Decoded image, already in the output form: interleaved samples, little-endian, Bits Allocated wide.
pub(crate) struct Image {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) components: usize,
    pub(crate) data: Vec<u8>,
    pub(crate) rgb: bool,
    /// Lossless: worth decoding again with the Cornell workaround (see `decode_frame`).
    pub(crate) retry_cornell: bool,
    /// Lossless: undecodable codes decoded as difference 0.
    pub(crate) bad_codes: u32,
}

impl Image {
    fn into_frame(self, info: &FrameInfo, max_bytes: usize) -> Result<DecodedFrame> {
        if self.width != info.columns as usize || self.height != info.rows as usize {
            return Err(invalid(&format!(
                "JPEG is {}x{} but the dataset says {}x{}",
                self.width, self.height, info.columns, info.rows
            )));
        }
        if self.components != usize::from(info.samples_per_pixel) {
            return Err(invalid(&format!(
                "JPEG has {} components but Samples per Pixel is {}",
                self.components, info.samples_per_pixel
            )));
        }
        if self.data.len() != max_bytes {
            return Err(invalid("decoded size does not match the frame"));
        }
        Ok(DecodedFrame {
            data: self.data,
            planar: false,
            color: if self.rgb { shl_codec_common::ColorOut::Rgb } else { shl_codec_common::ColorOut::AsDeclared },
        })
    }
}
