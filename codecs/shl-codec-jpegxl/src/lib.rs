//! JPEG XL for DICOM (1.2.840.10008.1.2.4.110 lossless, .111 JPEG recompression, .112): a thin
//! wrapper around this project's decoder, `shl-jpegxl`.
//!
//! The first displayed frame of the codestream is decoded and its colour channels are returned
//! as integers of the codestream's bit depth. Lossless (modular, non-XYB) images come back as
//! their exact sample values. Other images are rendered to floating point in the image's own
//! colour space and each sample `v` (nominal range 0.0–1.0) becomes `v × (2^bits − 1)` rounded
//! to nearest, ties to even, and clamped: libjxl's integer output without its 8-bit dither.
//! Signed data is carried as its two's-complement bit pattern, unsigned; the CLI sign-extends
//! from Bits Stored. Colour images (RGB, YBR_RCT, XYB, YBR_FULL_422 for .111) come back as RGB.
//!
//! See codec-corpus/formats/jpeg-xl/FORMAT.md.
#![forbid(unsafe_code)]

use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Result};
use shl_jpegxl::{Error, Options, Plane};

fn invalid(m: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(m.into())
}

fn unsupported(m: impl Into<String>) -> DecodeError {
    DecodeError::Unsupported(m.into())
}

fn map_err(e: Error) -> DecodeError {
    match e {
        Error::Invalid(_) => invalid(e.to_string()),
        Error::Unsupported(_) | Error::Limit(_) => unsupported(e.to_string()),
    }
}

/// Round to nearest, ties to even, for 0 ≤ v < 2^23 (adding and removing 2^23 makes the FPU
/// round; no libm call, as `round_ties_even` would be on targets without SSE4.1).
#[inline(always)]
fn round_even(v: f32) -> f32 {
    const M: f32 = 8_388_608.0;
    (v + M) - M
}

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let frame_bytes = info.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    if info.rows == 0 || info.columns == 0 {
        return Err(invalid("zero rows or columns"));
    }
    let bps = match info.bits_allocated {
        8 => 1usize,
        16 => 2,
        b => return Err(unsupported(format!("JPEG XL output with Bits Allocated {b}"))),
    };
    let spp = usize::from(info.samples_per_pixel);
    let hdr = shl_jpegxl::info(codestream).map_err(map_err)?;
    if hdr.width != info.columns || hdr.height != info.rows {
        return Err(invalid(format!(
            "JPEG XL image is {}x{} but the dataset says {}x{}",
            hdr.width, hdr.height, info.columns, info.rows
        )));
    }
    if hdr.num_color != spp {
        return Err(invalid(format!("JPEG XL has {} colour channel(s) but Samples per Pixel is {spp}", hdr.num_color)));
    }
    if hdr.bit_depth.float {
        return Err(unsupported("JPEG XL with floating-point samples"));
    }
    let bits = hdr.bit_depth.bits;
    if bits == 0 || bits as usize > 8 * bps {
        return Err(invalid(format!("JPEG XL samples have {bits} bits, more than Bits Allocated {}", info.bits_allocated)));
    }
    let pixels = u64::from(info.rows) * u64::from(info.columns);
    let img = shl_jpegxl::decode(codestream, &Options { max_pixels: pixels }).map_err(map_err)?;
    if img.width != info.columns || img.height != info.rows || img.num_color != spp || img.planes.len() < spp {
        return Err(invalid("JPEG XL decoded frame does not match the dataset"));
    }
    let n = pixels as usize;
    let max = (1u32 << bits) - 1;
    let mut data = Vec::new();
    data.try_reserve_exact(frame_bytes).map_err(|_| unsupported("cannot allocate the decoded frame"))?;
    data.resize(frame_bytes, 0);
    for (c, plane) in img.planes.iter().take(spp).enumerate() {
        let put = |data: &mut [u8], i: usize, q: u32| {
            let o = (i * spp + c) * bps;
            if bps == 1 {
                data[o] = q as u8;
            } else {
                data[o..o + 2].copy_from_slice(&(q as u16).to_le_bytes());
            }
        };
        match plane {
            Plane::Int(d) if d.len() == n => {
                for (i, &v) in d.iter().enumerate() {
                    put(&mut data, i, v.clamp(0, max as i32) as u32);
                }
            }
            Plane::Float(d) if d.len() == n => {
                let m = max as f32;
                for (i, &v) in d.iter().enumerate() {
                    // NaN clamps to 0, as libjxl's Clamp does.
                    let x = (v * m).max(0.0).min(m);
                    put(&mut data, i, round_even(x) as u32);
                }
            }
            _ => return Err(invalid("JPEG XL decoded plane has the wrong size")),
        }
    }
    Ok(DecodedFrame { data, planar: false, color: if spp == 3 { ColorOut::Rgb } else { ColorOut::AsDeclared } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::Photometric;

    fn info(rows: u32, columns: u32) -> FrameInfo {
        FrameInfo {
            rows,
            columns,
            samples_per_pixel: 1,
            bits_allocated: 8,
            bits_stored: 8,
            pixel_representation: 0,
            photometric: Photometric::Monochrome2,
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.110".into(),
        }
    }

    #[test]
    fn garbage_is_invalid() {
        assert!(matches!(decode_frame(b"not a jpeg xl", &info(4, 4)), Err(DecodeError::Invalid(_))));
        assert!(matches!(decode_frame(&[], &info(4, 4)), Err(DecodeError::Invalid(_))));
        assert!(matches!(decode_frame(&[0xFF, 0x0A], &info(4, 4)), Err(DecodeError::Invalid(_))));
    }
}
