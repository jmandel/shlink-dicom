//! JPEG 2000 (1.2.840.10008.1.2.4.90/.91) decoder: a thin wrapper around `hayro-jpeg2000`.
//! Owned by the jpeg2000 format agent; see codec-corpus/formats/jpeg2000/FORMAT.md.
//!
//! The wrapper does what hayro does not do for DICOM:
//! - strips a JP2 wrapper, so hayro's JP2 colour handling never applies;
//! - checks the main header against the data set before hayro allocates anything
//!   ([`prep::prepare`]);
//! - applies the DC level shift 2^(p−1) itself, while converting (hayro's
//!   `defer_level_shift`, which saves a pass over the frame), and takes it off again for
//!   signed components (hayro reads the SIZ sign bit and discards it);
//! - rounds and clamps hayro's f32 samples, and applies pydicom's signedness rules ([`prep::pack`],
//!   or row by row with [`prep::pack_rows`] when no component is subsampled).
//!
//! [`prep`] is shared with `shl-codec-htj2k`, which also decodes through
//! [`decode_frame_high_throughput`] (hayro with its HT block decoder, vendored patch 5).
#![forbid(unsafe_code)]

pub mod prep;

use hayro_jpeg2000::{DecodeSettings, DecoderContext, Image};
use shl_codec_common::{DecodeError, DecodedFrame, FrameInfo, Result};

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    decode(codestream, info, false)
}

/// Decode one HTJ2K frame through hayro with its HT block decoder enabled (vendored patch 5),
/// for `shl-codec-htj2k`. Returns an error for what that path does not decode (MIXED
/// code-blocks, more than one HT set, unusual code-block styles); the caller then uses
/// another decoder. JPEG 2000 frames decode exactly as with [`decode_frame`].
pub fn decode_frame_high_throughput(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    decode(codestream, info, true)
}

fn decode(codestream: &[u8], info: &FrameInfo, high_throughput: bool) -> Result<DecodedFrame> {
    let prep = prep::prepare(codestream, info)?;
    // The DC level shift is added below, while converting, instead of in a separate pass in
    // hayro (vendored patch 8): the same f32 additions, in the same order.
    let settings = DecodeSettings {
        resolve_palette_indices: false,
        strict: false,
        target_resolution: None,
        high_throughput,
        defer_level_shift: true,
    };
    let image = Image::new(prep.codestream, &settings).map_err(map_err)?;
    if image.width() != info.columns || image.height() != info.rows {
        return Err(DecodeError::Invalid("decoder disagrees with SIZ on the image size".into()));
    }
    let mut ctx = DecoderContext::default();
    let decoded = image.decode(&mut ctx).map_err(map_err)?;
    let planes = decoded.components();
    let pixels = (info.rows as usize) * (info.columns as usize);
    if planes.len() != prep.header.components.len() || planes.iter().any(|p| p.samples().len() < pixels) {
        return Err(DecodeError::Invalid("decoder returned fewer samples than the frame needs".into()));
    }
    // Hayro's DC level shift, 2^(p-1), is added here (it was told not to); signed components
    // take it off again, as when hayro added it: (s + 2^(p-1)) - 2^(p-1), in f32.
    let shifts: Vec<(f32, f32)> = prep
        .header
        .components
        .iter()
        .map(|c| {
            let shift = (1u32 << (c.precision - 1)) as f32;
            (shift, if c.signed { shift } else { 0.0 })
        })
        .collect();
    let planes: Vec<&[f32]> = planes.iter().map(|p| p.samples()).collect();
    // Hayro spreads subsampled components over the full image grid (each sample repeated
    // dx × dy times), so component sample (cx, cy) sits at pixel (cx·dx, cy·dy); prepare
    // has checked that the image offset is a multiple of the subsampling.
    let steps: Vec<(usize, usize)> =
        prep.header.components.iter().map(|c| (usize::from(c.dx), usize::from(c.dy))).collect();
    let w = info.columns as usize;
    // Fast path for full-resolution components: whole rows at a time. Rounding commutes with
    // clamping to integer bounds, so clamping to the SIZ range first gives what pack gives
    // (it clamps again) and keeps the conversion in range; NaN still becomes 0. Precision is
    // at most 16 (prepare refuses more), well inside round_clamped's ±2^22.
    let bounds: Vec<(f32, f32)> = prep
        .header
        .components
        .iter()
        .map(|c| {
            let p = i32::from(c.precision);
            let (lo, hi) = if c.signed { (-(1i64 << (p - 1)), (1i64 << (p - 1)) - 1) } else { (0, (1i64 << p) - 1) };
            (lo as f32, hi as f32)
        })
        .collect();
    if steps.iter().all(|&s| s == (1, 1)) {
        if let Some(r) = prep::pack_rows(info, &prep, |c, y, row| {
            let (lo, hi) = bounds[c];
            let (shift, unshift) = shifts[c];
            for (d, &s) in row.iter_mut().zip(&planes[c][y * w..(y + 1) * w]) {
                *d = prep::round_clamped((s + shift) - unshift, lo, hi);
            }
        }) {
            return r;
        }
    }
    prep::pack(info, &prep, |c, cx, cy| {
        let (dx, dy) = steps[c];
        // Rounds as `round() as i32` (saturating, NaN to 0); pack clamps to the SIZ range.
        let (shift, unshift) = shifts[c];
        prep::round_to_i32((planes[c][cy * dy * w + cx * dx] + shift) - unshift)
    })
}

fn map_err(e: hayro_jpeg2000::DecodeError) -> DecodeError {
    use hayro_jpeg2000::{DecodeError as H, FormatError, MarkerError};
    match e {
        H::Format(FormatError::Unsupported) | H::Marker(MarkerError::Unsupported) => {
            DecodeError::Unsupported(format!("JPEG 2000: {e}"))
        }
        _ => DecodeError::Invalid(format!("JPEG 2000: {e}")),
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
            pixel_representation: 1,
            photometric: Photometric::Monochrome2,
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.91".into(),
        }
    }

    /// The SIZ of `pydicom-JPEG2000-embedded-sequence-delimiter` (Xsiz 0xFEFFDDE0) once made
    /// hayro allocate about 15 TB and abort. It must be refused before hayro sees it.
    #[test]
    fn huge_siz_is_refused() {
        let mut cs = prep::tests::header(0xFEFF_DDE0, 1024, &[(16, true)], (0xFEFF_DDE0, 1024), false);
        cs.extend_from_slice(&[0xFF, 0x93, 0xFF, 0xD9]);
        assert!(matches!(decode_frame(&cs, &info(1024, 256)), Err(DecodeError::Invalid(_))));
    }

    #[test]
    fn garbage_is_invalid() {
        for data in [&b""[..], b"\xFF\x4F", b"\x00\x00\x00\x0CjP  \r\n\x87\n", b"hello world"] {
            assert!(decode_frame(data, &info(1, 1)).is_err());
        }
    }
}
