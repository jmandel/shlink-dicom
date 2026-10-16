//! DICOM RLE Lossless decoder (transfer syntax 1.2.840.10008.1.2.5, DICOM PS3.5 Annex G).
//! Owned by the rle format agent; see codec-corpus/AGENTS.md and codec-corpus/formats/rle/FORMAT.md.
//!
//! A frame is a 64-byte header (segment count, then 15 segment offsets, all little-endian u32)
//! followed by PackBits-compressed segments. Each segment holds one byte of every pixel for one
//! sample: for each sample in turn, the most significant byte first. Every segment decodes to
//! exactly rows × columns bytes. The output is therefore planar by nature.
#![forbid(unsafe_code)]

use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Result};

/// Size of the RLE header in bytes (PS3.5 G.5).
const HEADER_LEN: usize = 64;
/// The header has room for 15 segment offsets.
const MAX_SEGMENTS: usize = 15;

fn invalid(msg: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(msg.into())
}

fn read_u32_le(data: &[u8], pos: usize) -> Option<u32> {
    let b = data.get(pos..pos.checked_add(4)?)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Parse the RLE header and return the byte range of each segment within `data`.
///
/// Rules applied:
/// - the segment count is 1..=15;
/// - each used offset is at least 64, at most the data length, and not smaller than the one
///   before it (segments are stored in order);
/// - a segment ends where the next one starts; the last ends at the end of the data.
///   Unused offsets are ignored.
pub fn parse_header(data: &[u8]) -> Result<Vec<(usize, usize)>> {
    if data.len() < HEADER_LEN {
        return Err(invalid(format!("RLE frame is {} bytes, shorter than the 64-byte header", data.len())));
    }
    let count = read_u32_le(data, 0).ok_or_else(|| invalid("RLE header truncated"))?;
    let count = usize::try_from(count).map_err(|_| invalid("RLE segment count out of range"))?;
    if count == 0 || count > MAX_SEGMENTS {
        return Err(invalid(format!("RLE header declares {count} segments; must be 1 to 15")));
    }
    let mut offsets = Vec::with_capacity(count);
    for i in 0..count {
        let off = read_u32_le(data, 4 + 4 * i).ok_or_else(|| invalid("RLE header truncated"))?;
        let off = usize::try_from(off).map_err(|_| invalid("RLE segment offset out of range"))?;
        if off < HEADER_LEN {
            return Err(invalid(format!("RLE segment {i} offset {off} points into the header")));
        }
        if off > data.len() {
            return Err(invalid(format!(
                "RLE segment {i} offset {off} is past the end of the {}-byte frame",
                data.len()
            )));
        }
        if let Some(&prev) = offsets.last() {
            if off < prev {
                return Err(invalid(format!("RLE segment {i} offset {off} is before segment {}'s", i - 1)));
            }
        }
        offsets.push(off);
    }
    let mut ranges = Vec::with_capacity(count);
    for i in 0..count {
        let start = offsets[i];
        let end = offsets.get(i + 1).copied().unwrap_or(data.len());
        ranges.push((start, end));
    }
    Ok(ranges)
}

/// Decode one PackBits segment into `out`, filling it exactly.
///
/// Header byte n (as i8): 0..=127 copies the next n+1 bytes; -127..=-1 repeats the next byte
/// 1-n times; -128 is a no-op. Decoding stops once `out` is full, so trailing padding or a run
/// that overshoots the end of the segment is ignored (encoders pad segments to even length).
/// A segment that ends before `out` is full is an error.
pub fn unpack_bits(src: &[u8], out: &mut [u8]) -> Result<()> {
    let n = unpack_bits_partial(src, out);
    if n < out.len() {
        return Err(short_segment(n, out.len()));
    }
    Ok(())
}

fn short_segment(got: usize, want: usize) -> DecodeError {
    invalid(format!("RLE segment decodes to {got} bytes; expected {want}"))
}

/// Decode as much of one PackBits segment as fits in `out` and return the number of bytes
/// written. Stops at the end of `out` or of `src`, whichever comes first; a literal run cut
/// short by the end of `src` contributes the bytes that are present. Bytes of `out` past the
/// returned count are left untouched.
pub fn unpack_bits_partial(src: &[u8], out: &mut [u8]) -> usize {
    let want = out.len();
    let mut pos = 0usize; // into src
    let mut n = 0usize; // bytes written to out
    while n < want {
        let Some(&h) = src.get(pos) else { break };
        pos += 1;
        let h = h as i8;
        if h >= 0 {
            let len = usize::from(h as u8) + 1;
            let avail = src.len() - pos;
            let take = len.min(avail).min(want - n);
            out[n..n + take].copy_from_slice(&src[pos..pos + take]);
            n += take;
            pos += take;
        } else if h != -128 {
            let len = (1 - isize::from(h)) as usize; // 2..=128
            let Some(&v) = src.get(pos) else { break };
            pos += 1;
            let take = len.min(want - n);
            out[n..n + take].fill(v);
            n += take;
        }
    }
    n
}

/// Decode one segment into `out` (rows × columns bytes). A segment that ends at most one row
/// short is accepted and the missing bytes are set to 0, as dcmtk does (see FORMAT.md Rulings);
/// a larger shortfall is an error.
fn decode_segment(src: &[u8], out: &mut [u8], columns: usize) -> Result<()> {
    let n = unpack_bits_partial(src, out);
    let short = out.len() - n;
    if short > columns {
        return Err(short_segment(n, out.len()));
    }
    out[n..].fill(0);
    Ok(())
}

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
///
/// Returns planar data (all of sample 0, then sample 1, ...), little-endian, `bits_allocated`
/// wide, in the colour space the dataset declares.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let bps = match info.bits_allocated {
        8 => 1usize,
        16 => 2,
        32 => 4,
        b => return Err(DecodeError::Unsupported(format!("RLE with Bits Allocated {b}"))),
    };
    let spp = match info.samples_per_pixel {
        1 => 1usize,
        3 => 3,
        s => return Err(DecodeError::Unsupported(format!("RLE with Samples per Pixel {s}"))),
    };
    if info.rows == 0 || info.columns == 0 {
        return Err(invalid("RLE frame has zero rows or columns"));
    }
    let plane = (info.rows as usize)
        .checked_mul(info.columns as usize)
        .ok_or_else(|| invalid("frame dimensions overflow"))?;
    let cols = info.columns as usize;
    let total = info.frame_bytes().ok_or_else(|| invalid("frame dimensions overflow"))?;
    let expected_segments = spp * bps;

    let ranges = parse_header(codestream)?;
    if ranges.len() != expected_segments {
        return Err(invalid(format!(
            "RLE header declares {} segments; {} samples of {} bytes need {}",
            ranges.len(),
            spp,
            bps,
            expected_segments
        )));
    }

    // PackBits expands at most 128 output bytes per 2 input bytes, so a frame whose segments
    // could never fill the output is rejected before allocating.
    if codestream.len().saturating_mul(64) < total {
        return Err(invalid("RLE frame is too short for its declared dimensions"));
    }

    let mut data = vec![0u8; total];
    if bps == 1 {
        for (s, &(start, end)) in ranges.iter().enumerate() {
            let out = &mut data[s * plane..(s + 1) * plane];
            decode_segment(&codestream[start..end], out, cols)?;
        }
    } else {
        // A sample's segments come most significant byte first. The first goes into the start of
        // the sample's region of `data`, the others into `tmp`; then the region is filled with
        // little-endian samples from its end backwards, a block at a time. Block [a, i) of the
        // first segment is copied out before samples a..i are written over bytes bps·a..bps·i,
        // and those bytes lie at or beyond a, past the blocks still to be read.
        let mut tmp = vec![0u8; plane * (bps - 1)];
        for (s, segs) in ranges.chunks_exact(bps).enumerate() {
            let region = &mut data[s * plane * bps..(s + 1) * plane * bps];
            decode_segment(&codestream[segs[0].0..segs[0].1], &mut region[..plane], cols)?;
            for (&(start, end), out) in segs[1..].iter().zip(tmp.chunks_exact_mut(plane)) {
                decode_segment(&codestream[start..end], out, cols)?;
            }
            const B: usize = 512;
            let mut first = [0u8; B];
            let mut i = plane;
            while i > 0 {
                let a = i.saturating_sub(B);
                let first = &mut first[..i - a];
                first.copy_from_slice(&region[a..i]);
                let dst = &mut region[bps * a..bps * i];
                if bps == 2 {
                    for ((o, &h), &l) in dst.chunks_exact_mut(2).zip(&*first).zip(&tmp[a..i]) {
                        o.copy_from_slice(&[l, h]);
                    }
                } else {
                    let (b1, rest) = tmp.split_at(plane);
                    let (b2, b3) = rest.split_at(plane);
                    let it = first.iter().zip(&b1[a..i]).zip(&b2[a..i]).zip(&b3[a..i]);
                    for (o, (((&x0, &x1), &x2), &x3)) in dst.chunks_exact_mut(4).zip(it) {
                        o.copy_from_slice(&[x3, x2, x1, x0]);
                    }
                }
                i = a;
            }
        }
    }

    Ok(DecodedFrame { data, planar: true, color: ColorOut::AsDeclared })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::Photometric;

    fn info(rows: u32, cols: u32, spp: u16, bits: u16) -> FrameInfo {
        FrameInfo {
            rows,
            columns: cols,
            samples_per_pixel: spp,
            bits_allocated: bits,
            bits_stored: bits,
            pixel_representation: 0,
            photometric: if spp == 3 { Photometric::Rgb } else { Photometric::Monochrome2 },
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.5".into(),
        }
    }

    fn frame(segments: &[&[u8]]) -> Vec<u8> {
        let mut out = vec![0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&(segments.len() as u32).to_le_bytes());
        let mut off = HEADER_LEN;
        for (i, s) in segments.iter().enumerate() {
            out[4 + 4 * i..8 + 4 * i].copy_from_slice(&(off as u32).to_le_bytes());
            off += s.len();
        }
        for s in segments {
            out.extend_from_slice(s);
        }
        out
    }

    #[test]
    fn packbits_literal_and_run() {
        // literal 3 bytes, run of 4 x 0xAA, no-op, literal 1
        let src = [2, 1, 2, 3, (-3i8) as u8, 0xAA, 0x80, 0, 9];
        let mut out = [0u8; 8];
        unpack_bits(&src, &mut out).unwrap();
        assert_eq!(out, [1, 2, 3, 0xAA, 0xAA, 0xAA, 0xAA, 9]);
    }

    #[test]
    fn packbits_max_run() {
        let src = [(-127i8) as u8, 7];
        let mut out = [0u8; 128];
        unpack_bits(&src, &mut out).unwrap();
        assert!(out.iter().all(|&b| b == 7));
    }

    #[test]
    fn packbits_short_is_error() {
        let mut out = [0u8; 4];
        assert!(matches!(unpack_bits(&[1, 5, 6], &mut out), Err(DecodeError::Invalid(_))));
        assert!(matches!(unpack_bits(&[3, 5, 6], &mut out), Err(DecodeError::Invalid(_))));
        assert!(matches!(unpack_bits(&[(-1i8) as u8], &mut out), Err(DecodeError::Invalid(_))));
        assert!(matches!(unpack_bits(&[], &mut out), Err(DecodeError::Invalid(_))));
    }

    #[test]
    fn packbits_overshoot_and_padding_ignored() {
        let mut out = [0u8; 3];
        // run of 5 into 3 bytes; trailing pad byte
        unpack_bits(&[(-4i8) as u8, 1, 0], &mut out).unwrap();
        assert_eq!(out, [1, 1, 1]);
        // literal of 4 into 3 bytes, source cut short after 3
        unpack_bits(&[3, 4, 5, 6], &mut out).unwrap();
        assert_eq!(out, [4, 5, 6]);
    }

    #[test]
    fn sixteen_bit_msb_first() {
        // 2 pixels: 0x0102, 0x0304
        let f = frame(&[&[1, 1, 3], &[1, 2, 4]]);
        let d = decode_frame(&f, &info(1, 2, 1, 16)).unwrap();
        assert_eq!(d.data, [0x02, 0x01, 0x04, 0x03]);
        assert!(d.planar);
        assert_eq!(d.color, ColorOut::AsDeclared);
    }

    #[test]
    fn rgb8_planar() {
        let f = frame(&[&[0, 10], &[0, 20], &[0, 30]]);
        let d = decode_frame(&f, &info(1, 1, 3, 8)).unwrap();
        assert_eq!(d.data, [10, 20, 30]);
    }

    #[test]
    fn rgb32_segment_order() {
        // one pixel; segments: R3 R2 R1 R0 G3.. B0
        let segs: Vec<Vec<u8>> = (0..12u8).map(|i| vec![0, i]).collect();
        let refs: Vec<&[u8]> = segs.iter().map(|s| s.as_slice()).collect();
        let d = decode_frame(&frame(&refs), &info(1, 1, 3, 32)).unwrap();
        assert_eq!(d.data, [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8]);
    }

    #[test]
    fn header_errors() {
        let i = info(1, 1, 1, 8);
        assert!(matches!(decode_frame(&[0; 10], &i), Err(DecodeError::Invalid(_))));
        let mut f = frame(&[&[0, 1]]);
        f[0] = 2; // segment count mismatch (second offset 0 -> into header)
        assert!(matches!(decode_frame(&f, &i), Err(DecodeError::Invalid(_))));
        let mut f = frame(&[&[0, 1]]);
        f[4] = 200; // offset past end
        assert!(matches!(decode_frame(&f, &i), Err(DecodeError::Invalid(_))));
        let mut f = frame(&[&[0, 1]]);
        f[0] = 16;
        assert!(matches!(decode_frame(&f, &i), Err(DecodeError::Invalid(_))));
        // wrong segment count for 16-bit
        let f = frame(&[&[0, 1]]);
        assert!(matches!(decode_frame(&f, &info(1, 1, 1, 16)), Err(DecodeError::Invalid(_))));
        // decreasing offsets
        let mut f = frame(&[&[0, 1], &[0, 2]]);
        f[8..12].copy_from_slice(&63u32.to_le_bytes());
        assert!(matches!(decode_frame(&f, &info(1, 1, 1, 16)), Err(DecodeError::Invalid(_))));
    }

    #[test]
    fn short_segment_up_to_one_row_padded_with_zero() {
        // 2 rows x 3 columns, 8-bit. Segment supplies 4 of 6 bytes: short by 2 <= 3 columns.
        let f = frame(&[&[3, 9, 8, 7, 6]]);
        let d = decode_frame(&f, &info(2, 3, 1, 8)).unwrap();
        assert_eq!(d.data, [9, 8, 7, 6, 0, 0]);
        // Short by exactly one row is still accepted.
        let f = frame(&[&[2, 9, 8, 7]]);
        assert_eq!(decode_frame(&f, &info(2, 3, 1, 8)).unwrap().data, [9, 8, 7, 0, 0, 0]);
        // Short by more than one row is Invalid.
        let f = frame(&[&[1, 9, 8]]);
        assert!(matches!(decode_frame(&f, &info(2, 3, 1, 8)), Err(DecodeError::Invalid(_))));
        // 16-bit: the padded tail of the low-byte segment is 0, and a reused buffer from the
        // previous segment must not leak into it.
        let f = frame(&[&[(-2i8) as u8, 0xAB], &[0, 0x11]]);
        let d = decode_frame(&f, &info(1, 3, 1, 16)).unwrap();
        assert_eq!(d.data, [0x11, 0xAB, 0x00, 0xAB, 0x00, 0xAB]);
    }

    #[test]
    fn huge_dimensions_rejected_without_allocating() {
        let f = frame(&[&[(-127i8) as u8, 0]]);
        let i = info(u32::MAX, u32::MAX, 1, 8);
        assert!(decode_frame(&f, &i).is_err());
        let i = info(60000, 60000, 1, 8);
        assert!(matches!(decode_frame(&f, &i), Err(DecodeError::Invalid(_))));
    }
}
