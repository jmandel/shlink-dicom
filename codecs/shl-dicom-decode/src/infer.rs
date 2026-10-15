//! Evidence for filling in missing or impossible Image Pixel attributes instead of refusing the
//! file: the frame's own codestream header (JPEG SOF, JPEG-LS SOF55, JPEG 2000 SIZ) and, for
//! native colour data with no Planar Configuration, which layout gives the smoother image.
//!
//! Every inference is reported in [`crate::Canonical::inferred`]; see codec-corpus/formats/
//! uncompressed/FORMAT.md, "Rulings", for the rules and the evidence behind them.

use crate::parse::{read_u16, read_u32};
use crate::pixel;

/// One attribute value the decoder filled in or replaced, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inference {
    /// DICOM keyword, e.g. "PlanarConfiguration".
    pub attribute: &'static str,
    /// The value used, as text.
    pub value: String,
    pub reason: String,
}

impl Inference {
    pub fn new(attribute: &'static str, value: impl ToString, reason: impl Into<String>) -> Self {
        Self { attribute, value: value.to_string(), reason: reason.into() }
    }
}

/// What a frame's codestream header says about the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodestreamInfo {
    pub rows: u32,
    pub columns: u32,
    pub components: u16,
    /// Sample precision in bits (the largest over components for JPEG 2000).
    pub precision: u16,
    /// JPEG 2000 only: the first component is signed.
    pub signed: Option<bool>,
    /// "SOF" or "SIZ", for messages.
    pub source: &'static str,
}

/// Read the image header of a JPEG family (SOF) or JPEG 2000 (SIZ) codestream.
pub fn peek_codestream(ts: &str, cs: &[u8]) -> Option<CodestreamInfo> {
    match ts {
        "1.2.840.10008.1.2.4.50" | "1.2.840.10008.1.2.4.51" | "1.2.840.10008.1.2.4.57" | "1.2.840.10008.1.2.4.70"
        | "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81" => peek_jpeg(cs),
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202"
        | "1.2.840.10008.1.2.4.203" => peek_j2k(cs),
        _ => None,
    }
}

/// Walk JPEG marker segments from SOI to the first SOFn (or JPEG-LS SOF55).
fn peek_jpeg(cs: &[u8]) -> Option<CodestreamInfo> {
    if cs.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut at = 2usize;
    loop {
        // Skip fill bytes before a marker.
        while cs.get(at)? == &0xFF && cs.get(at + 1)? == &0xFF {
            at += 1;
        }
        if cs.get(at)? != &0xFF {
            return None;
        }
        let marker = *cs.get(at + 1)?;
        let len = usize::from(read_u16(cs.get(at + 2..at + 4)?, false)?);
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) || marker == 0xF7;
        if is_sof {
            let seg = cs.get(at + 4..at + 2 + len)?;
            let precision = u16::from(*seg.first()?);
            let rows = u32::from(read_u16(seg.get(1..3)?, false)?);
            let columns = u32::from(read_u16(seg.get(3..5)?, false)?);
            let components = u16::from(*seg.get(5)?);
            return Some(CodestreamInfo { rows, columns, components, precision, signed: None, source: "SOF" });
        }
        if marker == 0xDA || marker == 0xD9 || len < 2 {
            return None; // scan data or end before any SOF
        }
        at = at.checked_add(2 + len)?;
    }
}

/// SIZ (ISO/IEC 15444-1 A.5.1), also inside a JP2 wrapper (searched in the first 4 KiB).
fn peek_j2k(cs: &[u8]) -> Option<CodestreamInfo> {
    let head = cs.get(..cs.len().min(4096))?;
    let at = head.windows(4).position(|w| w == [0xFF, 0x4F, 0xFF, 0x51])? + 2;
    let siz = cs.get(at..)?;
    let x = read_u32(siz.get(6..10)?, false)?;
    let y = read_u32(siz.get(10..14)?, false)?;
    let xo = read_u32(siz.get(14..18)?, false)?;
    let yo = read_u32(siz.get(18..22)?, false)?;
    let components = read_u16(siz.get(38..40)?, false)?;
    let mut precision = 0u16;
    let mut signed = None;
    for k in 0..usize::from(components) {
        let ssiz = *siz.get(40 + 3 * k)?;
        precision = precision.max(u16::from(ssiz & 0x7F) + 1);
        signed.get_or_insert(ssiz & 0x80 != 0);
    }
    Some(CodestreamInfo {
        rows: y.checked_sub(yo)?,
        columns: x.checked_sub(xo)?,
        components,
        precision,
        signed,
        source: "SIZ",
    })
}

/// Bits Allocated that holds `precision` bits.
pub fn container_bits(precision: u16) -> Option<u16> {
    match precision {
        1..=8 => Some(8),
        9..=16 => Some(16),
        17..=32 => Some(32),
        _ => None,
    }
}

/// Which layout a native 3-sample frame with no Planar Configuration uses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Layout {
    /// Both readings give the same pixels (e.g. a single pixel or a constant image).
    Either,
    /// The planar configuration that gives the clearly smoother image, and the two roughness
    /// scores (interleaved, planar).
    Clear(u16, f64, f64),
    /// Neither reading is clearly smoother.
    Ambiguous(f64, f64),
}

/// The smoother reading must be at least this much smoother. On the real files without the
/// attribute (Philips IntelliSpace Portal, GE LOGIQ E9) the margin was 1.8× to 9×.
pub const PLANAR_MARGIN: f64 = 1.25;
/// Smallest frame the layout is judged on: at least 4 pixels each way and 256 in all.
pub const MIN_EXTENT: usize = 4;
pub const MIN_PIXELS: usize = 256;

/// Score both readings of one frame (`frame`: little-endian samples of `bps` bytes, rows ×
/// columns × 3) by roughness: the mean absolute difference between horizontally and vertically
/// adjacent samples of the same channel, summed. The wrong reading of planar data tiles the image
/// 3×3 at a third of its size; the wrong reading of interleaved data jumps a third of a row per
/// line. Either way it is rougher.
pub fn planar_layout(frame: &[u8], rows: usize, columns: usize, bps: usize, bits_stored: u16, signed: bool) -> Layout {
    let mut planar_view = vec![0u8; frame.len()];
    if pixel::interleave_into(frame, &mut planar_view, 3, bps).is_err() {
        return Layout::Ambiguous(0.0, 0.0);
    }
    if planar_view == frame {
        return Layout::Either;
    }
    // Too few pixels to judge: a 3×3 test image of distinct colours scored 2× "smoother" the
    // wrong way (pydicom's SC_rgb_small_odd with the attribute removed).
    if rows < MIN_EXTENT || columns < MIN_EXTENT || rows * columns < MIN_PIXELS {
        return Layout::Ambiguous(0.0, 0.0);
    }
    let interleaved = roughness(frame, rows, columns, bps, bits_stored, signed);
    let planar = roughness(&planar_view, rows, columns, bps, bits_stored, signed);
    if planar * PLANAR_MARGIN < interleaved {
        Layout::Clear(1, interleaved, planar)
    } else if interleaved * PLANAR_MARGIN < planar {
        Layout::Clear(0, interleaved, planar)
    } else {
        Layout::Ambiguous(interleaved, planar)
    }
}

fn sample(px: &[u8], bps: usize, bits_stored: u16, signed: bool) -> i64 {
    let mut b = [0u8; 8];
    if let (Some(dst), Some(src)) = (b.get_mut(..bps), px.get(..bps)) {
        dst.copy_from_slice(src);
    }
    let raw = u64::from_le_bytes(b);
    let bits = u32::from(bits_stored).clamp(1, 32);
    let low = raw & ((1u64 << bits) - 1);
    if signed && (low >> (bits - 1)) & 1 == 1 {
        low as i64 - (1i64 << bits)
    } else {
        low as i64
    }
}

/// Mean |horizontal difference| + mean |vertical difference| over the three channels of an
/// interleaved frame. Large frames are sampled every few rows to bound the work.
fn roughness(frame: &[u8], rows: usize, columns: usize, bps: usize, bits_stored: u16, signed: bool) -> f64 {
    let row_bytes = columns * 3 * bps;
    if row_bytes == 0 {
        return 0.0;
    }
    let step = (rows / 512).max(1);
    let (mut h, mut hn, mut v, mut vn) = (0u64, 0u64, 0u64, 0u64);
    let mut r = 0;
    while r < rows {
        let Some(line) = frame.get(r * row_bytes..(r + 1) * row_bytes) else { break };
        let next = frame.get((r + 1) * row_bytes..(r + 2) * row_bytes);
        for (c, px) in line.chunks_exact(bps).enumerate() {
            let a = sample(px, bps, bits_stored, signed);
            if let Some(right) = line.get((c + 3) * bps..(c + 4) * bps) {
                h += a.abs_diff(sample(right, bps, bits_stored, signed));
                hn += 1;
            }
            if let Some(below) = next.and_then(|n| n.get(c * bps..(c + 1) * bps)) {
                v += a.abs_diff(sample(below, bps, bits_stored, signed));
                vn += 1;
            }
        }
        r += step;
    }
    let mean = |s: u64, n: u64| if n == 0 { 0.0 } else { s as f64 / n as f64 };
    mean(h, hn) + mean(v, vn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smooth synthetic colour image (rows × columns × 3, interleaved).
    fn smooth(rows: usize, cols: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for r in 0..rows {
            for c in 0..cols {
                let d = ((r as i32 - 20).pow(2) + (c as i32 - 30).pow(2)) as f64;
                v.extend_from_slice(&[(c * 4 % 256) as u8, (r * 5 % 256) as u8, (255.0 * (-d / 900.0).exp()) as u8]);
            }
        }
        v
    }

    fn to_planar(px: &[u8]) -> Vec<u8> {
        (0..3).flat_map(|s| px.iter().skip(s).step_by(3).copied()).collect()
    }

    #[test]
    fn picks_the_smooth_layout() {
        let (rows, cols) = (48, 64);
        let img = smooth(rows, cols);
        assert!(matches!(planar_layout(&img, rows, cols, 1, 8, false), Layout::Clear(0, _, _)));
        assert!(matches!(planar_layout(&to_planar(&img), rows, cols, 1, 8, false), Layout::Clear(1, _, _)));
    }

    #[test]
    fn noise_is_ambiguous_and_constant_is_either() {
        let mut x: u32 = 7;
        let noise: Vec<u8> = (0..32 * 32 * 3)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        assert!(matches!(planar_layout(&noise, 32, 32, 1, 8, false), Layout::Ambiguous(..)));
        assert_eq!(planar_layout(&[9; 30], 2, 5, 1, 8, false), Layout::Either);
        // A tiny image of distinct colours cannot be judged.
        let tiny: Vec<u8> = (0..27u8).map(|i| i.wrapping_mul(37)).collect();
        assert!(matches!(planar_layout(&tiny, 3, 3, 1, 8, false), Layout::Ambiguous(..)));
    }

    #[test]
    fn sixteen_bit_layouts() {
        let (rows, cols) = (40, 40);
        let img: Vec<u8> = smooth(rows, cols).iter().flat_map(|&b| (u16::from(b) * 16).to_le_bytes()).collect();
        assert!(matches!(planar_layout(&img, rows, cols, 2, 12, false), Layout::Clear(0, _, _)));
        let planes: Vec<u8> = (0..3)
            .flat_map(|s| img.chunks_exact(2).skip(s).step_by(3).flatten().copied().collect::<Vec<_>>())
            .collect();
        assert!(matches!(planar_layout(&planes, rows, cols, 2, 12, false), Layout::Clear(1, _, _)));
    }

    #[test]
    fn reads_sof_and_siz() {
        // SOI, APP0 (len 4), SOF1: P=12, Y=300, X=200, Nf=1
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC1, 0, 11, 12, 1, 44, 0, 200, 1, 1, 0x11, 0];
        let i = peek_codestream("1.2.840.10008.1.2.4.51", &jpeg).unwrap();
        assert_eq!((i.rows, i.columns, i.precision, i.components), (300, 200, 12, 1));
        let mut j2k = vec![0xFF, 0x4F, 0xFF, 0x51, 0, 41, 0, 0];
        for v in [110u32, 70, 10, 20, 110, 70, 0, 0] {
            j2k.extend_from_slice(&v.to_be_bytes());
        }
        j2k.extend_from_slice(&[0, 1, 0x8F, 1, 1]);
        let i = peek_codestream("1.2.840.10008.1.2.4.90", &j2k).unwrap();
        assert_eq!((i.rows, i.columns, i.precision, i.signed), (50, 100, 16, Some(true)));
        assert_eq!(peek_codestream("1.2.840.10008.1.2.4.90", b"garbage"), None);
        assert_eq!(peek_codestream("1.2.840.10008.1.2.4.50", &[0xFF, 0xD8, 0xFF]), None);
    }
}
