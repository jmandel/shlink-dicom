//! JPEG XL for DICOM (1.2.840.10008.1.2.4.110 lossless, .111 JPEG recompression, .112): a thin
//! wrapper around `jxl-oxide` (pure Rust, single-threaded here).
//!
//! The first keyframe of the codestream is rendered and its colour channels are returned as
//! integers of the codestream's bit depth, the way libjxl returns them for an integer output
//! buffer: each rendered sample `v` (nominal range 0.0–1.0) becomes `round(v × (2^bits − 1))`,
//! clamped. For lossless (modular, integer) data this gives the stored values exactly. Signed
//! data is carried as its two's-complement bit pattern, unsigned; the CLI sign-extends from Bits
//! Stored. Colour images (RGB, YBR_RCT, XYB, YBR_FULL_422 for .111) come back as RGB.
//!
//! See codec-corpus/formats/jpeg-xl/FORMAT.md.
#![forbid(unsafe_code)]

use jxl_oxide::color::{ColourEncoding, EnumColourEncoding, TransferFunction};
use jxl_oxide::{AllocTracker, InitializeResult, JxlImage, JxlThreadPool, PixelFormat};
use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Result};

fn invalid(m: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(m.into())
}

fn unsupported(m: impl Into<String>) -> DecodeError {
    DecodeError::Unsupported(m.into())
}

/// Bytes jxl-oxide may allocate for image buffers while decoding a frame of `samples` output
/// samples: its working buffers are 32-bit, per channel, with group padding, plus room for extra
/// channels and the frame's own small allocations.
fn alloc_limit(samples: usize) -> usize {
    samples.saturating_mul(4 * 12).saturating_add(64 << 20)
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
    let samples = frame_bytes / bps;

    let mut uninit = JxlImage::builder()
        .pool(JxlThreadPool::none())
        .alloc_tracker(AllocTracker::with_limit(alloc_limit(samples)))
        .build_uninit();
    uninit.feed_bytes(codestream).map_err(|e| invalid(format!("JPEG XL: {e}")))?;
    let mut image = match uninit.try_init().map_err(|e| invalid(format!("JPEG XL: {e}")))? {
        InitializeResult::Initialized(image) => image,
        InitializeResult::NeedMoreData(_) => return Err(invalid("JPEG XL codestream ends inside its header")),
    };
    image.finalize().map_err(|e| invalid(format!("JPEG XL: {e}")))?;

    if image.width() != info.columns || image.height() != info.rows {
        return Err(invalid(format!(
            "JPEG XL image is {}x{} but the dataset says {}x{}",
            image.width(),
            image.height(),
            info.columns,
            info.rows
        )));
    }
    let channels = match image.pixel_format() {
        PixelFormat::Gray | PixelFormat::Graya => 1,
        PixelFormat::Rgb | PixelFormat::Rgba => 3,
        f => return Err(unsupported(format!("JPEG XL pixel format {f:?}"))),
    };
    if channels != spp {
        return Err(invalid(format!("JPEG XL has {channels} colour channel(s) but Samples per Pixel is {spp}")));
    }
    let bits = match image.image_header().metadata.bit_depth {
        jxl_oxide::image::BitDepth::IntegerSample { bits_per_sample } => bits_per_sample,
        jxl_oxide::image::BitDepth::FloatSample { .. } => {
            return Err(unsupported("JPEG XL with floating-point samples"));
        }
    };
    if bits == 0 || bits as usize > 8 * bps {
        return Err(invalid(format!(
            "JPEG XL samples have {bits} bits, more than Bits Allocated {}",
            info.bits_allocated
        )));
    }
    if image.num_loaded_keyframes() == 0 {
        return Err(invalid("JPEG XL codestream ends before its first frame is complete"));
    }

    // An XYB image is rendered to its suggested colour space. jxl-oxide applies the sRGB transfer
    // curve with a fast approximation (relative error about 1e-4, up to 8 at 16 bits), so render
    // linear light instead and apply the exact sRGB curve here, as libjxl's decoder does.
    let exact_srgb = match &image.image_header().metadata.colour_encoding {
        ColourEncoding::Enum(e) if image.image_header().metadata.xyb_encoded && e.tf == TransferFunction::Srgb => {
            image.request_color_encoding(EnumColourEncoding { tf: TransferFunction::Linear, ..e.clone() });
            true
        }
        _ => false,
    };

    let render = image.render_frame(0).map_err(|e| invalid(format!("JPEG XL: {e}")))?;
    let mut stream = render.stream_no_alpha();
    if stream.channels() as usize != spp || stream.width() != info.columns || stream.height() != info.rows {
        return Err(invalid("JPEG XL rendered frame does not match the dataset"));
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(samples).map_err(|_| unsupported("cannot allocate the decoded frame"))?;
    buf.resize(samples, 0f32);
    if stream.write_to_buffer(&mut buf) != samples {
        return Err(invalid("JPEG XL rendered fewer samples than the frame holds"));
    }

    if exact_srgb {
        for v in &mut buf {
            *v = linear_to_srgb(*v);
        }
    }

    let max = ((1u64 << bits) - 1) as f32;
    let mut data = Vec::new();
    data.try_reserve_exact(frame_bytes).map_err(|_| unsupported("cannot allocate the decoded frame"))?;
    for v in buf {
        // The same conversion as libjxl's float to unsigned integer output.
        let q = (v * max + 0.5).clamp(0.0, max) as u32;
        if bps == 1 {
            data.push(q as u8);
        } else {
            data.extend_from_slice(&(q as u16).to_le_bytes());
        }
    }
    Ok(DecodedFrame { data, planar: false, color: if spp == 3 { ColorOut::Rgb } else { ColorOut::AsDeclared } })
}

/// The sRGB transfer curve (IEC 61966-2-1), computed in f64; negative values mirror.
fn linear_to_srgb(v: f32) -> f32 {
    let x = f64::from(v).abs();
    let y = if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    (y as f32).copysign(v)
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
