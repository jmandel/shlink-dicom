//! JPEG 2000 (1.2.840.10008.1.2.4.90/.91, Part 2 multi-component .92/.93) and HTJ2K
//! (.201/.202/.203) decoder: a thin wrapper around `shl-jpeg2000`.
//! See codec-corpus/formats/jpeg2000/FORMAT.md and codec-corpus/formats/htj2k/FORMAT.md.
//!
//! The wrapper does what the codestream decoder does not do for DICOM:
//! - strips a JP2 wrapper;
//! - checks the main header against the data set before anything is allocated
//!   ([`prep::prepare`]);
//! - applies the DC level shift 2^(p−1) to unsigned components while converting;
//! - rounds and clamps irreversible samples, and applies pydicom's signedness rules
//!   ([`prep::pack`], or row by row with [`prep::pack_rows`] when no component is subsampled).
//!
//! A codestream with a Part 2 multiple component transformation (T.801 Annex J) is decoded to
//! the components CBD declares, without a DC level shift. In a volumetric file each of those
//! components is a frame (DICOM PS3.5 A.4.4); [`decode_frames`] returns all of them, and
//! [`decode_frame`] refuses a codestream that holds more than one.
//!
//! HTJ2K code-blocks (T.814) are decoded by the same decoder, wherever the codestream's CAP
//! and code-block styles declare them, so `shl-codec-htj2k` calls this crate.
#![forbid(unsafe_code)]

pub mod prep;

use shl_jpeg2000::{Options, Plane};
use shl_codec_common::{scaled_extent, DecodeError, DecodedFrame, DecodedScaled, FrameInfo, Result};

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    decode(codestream, info, 0)
}

/// Decode a codestream that may hold several frames: a JPEG 2000 Part 2 codestream whose
/// components are the frames of a volume (DICOM PS3.5 A.4.4), Samples per Pixel components
/// per frame, in order. Returns the number of frames and their samples, frame after frame,
/// each frame as [`decode_frame`] would return it. A codestream with one frame gives 1.
pub fn decode_frames(codestream: &[u8], info: &FrameInfo) -> Result<(usize, DecodedFrame)> {
    decode_multi(codestream, info, 0, true)
}

/// Group the fragments of encapsulated Pixel Data into codestreams: a new codestream starts
/// at each fragment that begins with SOC + SIZ (or a JP2 signature). For JPEG 2000 Part 2,
/// where a codestream may hold the frames of a volume or of one component collection
/// (DICOM PS3.5 A.4.4), instead of one frame. Fragments before the first such start are
/// joined into the first codestream.
pub fn codestreams<'a>(fragments: impl IntoIterator<Item = &'a [u8]>) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    for f in fragments {
        let starts = f.starts_with(&[0xFF, 0x4F, 0xFF, 0x51]) || f.starts_with(&prep::JP2_SIGNATURE);
        match out.last_mut() {
            Some(last) if !starts => last.extend_from_slice(f),
            _ => out.push(f.to_vec()),
        }
    }
    out
}

/// Decode one frame at 1/2^`scale_log2` size (`shl_codec_common::DecodeScaledFn`) by
/// discarding the `scale_log2` highest resolution levels, as OpenJPEG's `reduce` does: the
/// code-blocks of those levels are not decoded and their wavelet synthesis is skipped. The
/// result is ceil(rows / 2^s) × ceil(columns / 2^s).
///
/// Returns `Unsupported` (the caller then decodes in full and downsamples) when the frame
/// cannot be reduced that way:
/// - some component has fewer than `scale_log2` decomposition levels;
/// - the image origin (XOsiz, YOsiz) is not (0, 0), where the reduced grid would not be the
///   CONTRACT size;
/// - subsampled (sYCC) components, unless the frame is one tile whose size is a multiple of the
///   subsampling times 2^s (the case checked against OpenJPEG).
pub fn decode_frame_scaled(codestream: &[u8], info: &FrameInfo, scale_log2: u8) -> Result<DecodedScaled> {
    let frame = decode(codestream, info, scale_log2)?;
    Ok(DecodedScaled { frame, rows: scaled_extent(info.rows, scale_log2), columns: scaled_extent(info.columns, scale_log2) })
}

/// `reduce` > 0: discard that many resolution levels; the frame is then `out` (the reduced
/// size) instead of `info`.
fn decode(codestream: &[u8], full: &FrameInfo, reduce: u8) -> Result<DecodedFrame> {
    decode_multi(codestream, full, reduce, false).map(|(_, frame)| frame)
}

/// `frames`: the codestream may hold several frames (see [`decode_frames`]).
fn decode_multi(codestream: &[u8], full: &FrameInfo, reduce: u8, frames: bool) -> Result<(usize, DecodedFrame)> {
    let prep = prep::prepare_part2(codestream, full, frames)?;
    let reduced;
    let info = if reduce == 0 {
        full
    } else {
        let h = &prep.header;
        if reduce > 31 {
            return Err(DecodeError::Unsupported(format!("JPEG 2000 reduction by 2^{reduce}")));
        }
        if h.x0 != 0 || h.y0 != 0 {
            return Err(DecodeError::Unsupported("reduced JPEG 2000 decode with a non-zero image origin".into()));
        }
        if let Some((dx, dy)) = prep.sycc() {
            // Verified against OpenJPEG only for one tile where every reduced chroma sample
            // covers whole reduced pixels (no odd-size edges); anything else falls back.
            let (sx, sy) = (u64::from(dx) << reduce, u64::from(dy) << reduce);
            if h.tiles != 1 || !u64::from(h.width).is_multiple_of(sx) || !u64::from(h.height).is_multiple_of(sy) {
                return Err(DecodeError::Unsupported(
                    "reduced JPEG 2000 decode of subsampled components with several tiles or an odd-sized edge".into(),
                ));
            }
        }
        reduced = FrameInfo { rows: scaled_extent(full.rows, reduce), columns: scaled_extent(full.columns, reduce), ..full.clone() };
        &reduced
    };
    let image = shl_jpeg2000::decode(prep.codestream, &Options { reduce }).map_err(map_err)?;
    // The decoder and `prep` read the Part 2 header separately; they must agree.
    let decoded: Vec<(u8, bool)> = image.components.iter().map(|c| (c.precision, c.signed)).collect();
    let expected: Vec<(u8, bool)> = prep.header.components.iter().map(|c| (c.precision, c.signed)).collect();
    if image.part2 != prep.header.part2 || decoded != expected {
        return Err(DecodeError::Invalid("JPEG 2000 component bit depths are inconsistent".into()));
    }
    if image.width != info.columns || image.height != info.rows {
        if reduce > 0 {
            return Err(DecodeError::Unsupported("reduced JPEG 2000 grid differs from ceil(size / 2^s)".into()));
        }
        return Err(DecodeError::Invalid("decoder disagrees with SIZ on the image size".into()));
    }
    for (c, comp) in image.components.iter().enumerate() {
        let (cw, ch) = if reduce == 0 {
            prep.component_size(c)
        } else {
            (comp.width, comp.height)
        };
        let len = match &comp.plane {
            Plane::Int(v) => v.len(),
            Plane::Float(v) => v.len(),
        };
        if comp.width != cw || comp.height != ch || len < cw as usize * ch as usize {
            return Err(DecodeError::Invalid("decoder output disagrees with SIZ".into()));
        }
    }
    // The DC level shift, 2^(p-1), for unsigned components: (s + 2^(p-1)) - 2^(p-1) for
    // signed ones, which in f32 is the rounding of the decoder this replaced.
    let shifts: Vec<(i32, i32)> = prep
        .header
        .components
        .iter()
        .map(|c| {
            // A Part 2 transformation replaces the DC level shift (T.801 Annex J).
            let shift = if prep.header.part2 { 0 } else { 1i32 << (c.precision - 1) };
            (shift, if c.signed { shift } else { 0 })
        })
        .collect();
    // Clamping to the SIZ range before rounding gives what pack gives (it clamps again) and
    // keeps the conversion in range; NaN becomes 0. Precision is at most 16 (prepare refuses
    // more), well inside round_clamped's ±2^22.
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
    let subsampled = image.components.iter().any(|c| c.dx != 1 || c.dy != 1);
    let spp = usize::from(info.samples_per_pixel);
    let count = image.components.len() / spp.max(1);
    let w = info.columns as usize;
    // One frame: the usual case. Several (a Part 2 volume): each frame is packed from its own
    // components, as if it were a codestream of its own.
    let pack_frame = |f: usize| -> Result<DecodedFrame> {
        let base = f * spp;
        let one;
        let prep = if count == 1 {
            &prep
        } else {
            let h = &prep.header;
            one = prep::Prepared {
                codestream: prep.codestream,
                header: prep::MainHeader {
                    width: h.width,
                    height: h.height,
                    x0: h.x0,
                    y0: h.y0,
                    tile_width: h.tile_width,
                    tile_height: h.tile_height,
                    tiles: h.tiles,
                    components: h.components[base..base + spp].to_vec(),
                    mct: h.mct,
                    part2: h.part2,
                    codestream_components: Vec::new(),
                },
            };
            &one
        };
        if !subsampled {
            if let Some(r) = prep::pack_rows(info, prep, |c, y, row| {
                let c = base + c;
                let (shift, unshift) = shifts[c];
                match &image.components[c].plane {
                    Plane::Int(v) => {
                        for (d, &s) in row.iter_mut().zip(&v[y * w..(y + 1) * w]) {
                            *d = s.saturating_add(shift - unshift);
                        }
                    }
                    Plane::Float(v) => {
                        let (lo, hi) = bounds[c];
                        let (shift, unshift) = (shift as f32, unshift as f32);
                        for (d, &s) in row.iter_mut().zip(&v[y * w..(y + 1) * w]) {
                            *d = prep::round_clamped((s + shift) - unshift, lo, hi);
                        }
                    }
                }
            }) {
                return r;
            }
        }
        prep::pack(info, prep, |c, cx, cy| {
            let c = base + c;
            let comp = &image.components[c];
            let i = cy * comp.width as usize + cx;
            let (shift, unshift) = shifts[c];
            match &comp.plane {
                Plane::Int(v) => v[i].saturating_add(shift - unshift),
                // Rounds as `round() as i32` (saturating, NaN to 0); pack clamps to the SIZ range.
                Plane::Float(v) => prep::round_to_i32((v[i] + shift as f32) - unshift as f32),
            }
        })
    };
    if count == 1 {
        return pack_frame(0).map(|f| (1, f));
    }
    if !frames {
        return Err(DecodeError::Unsupported(format!("JPEG 2000 codestream holds {count} frames")));
    }
    let frame_bytes = info.frame_bytes().ok_or_else(|| DecodeError::Invalid("frame size overflows".into()))?;
    let mut data = Vec::new();
    data.try_reserve_exact(frame_bytes.saturating_mul(count))
        .map_err(|_| DecodeError::Unsupported(format!("cannot allocate {count} frames")))?;
    let mut color = shl_codec_common::ColorOut::AsDeclared;
    for f in 0..count {
        let frame = pack_frame(f)?;
        data.extend_from_slice(&frame.data);
        color = frame.color;
    }
    Ok((count, DecodedFrame { data, planar: false, color }))
}

fn map_err(e: shl_jpeg2000::Error) -> DecodeError {
    match e {
        shl_jpeg2000::Error::Unsupported(m) => DecodeError::Unsupported(format!("JPEG 2000: {m}")),
        shl_jpeg2000::Error::Invalid(m) => DecodeError::Invalid(format!("JPEG 2000: {m}")),
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

    /// The SIZ of `pydicom-JPEG2000-embedded-sequence-delimiter` (Xsiz 0xFEFFDDE0) describes
    /// about 15 TB of samples. It must be refused before anything is allocated.
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
