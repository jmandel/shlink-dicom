//! Hierarchical JPEG (T.81 Annex J; processes 16–29): a DHP marker gives the final image, then a
//! sequence of frames each refines some components. The first frame of a component is an
//! ordinary (non-differential) frame, possibly smaller; each later, differential, frame codes
//! the difference from the previous reconstruction, expanded 2× horizontally and/or vertically
//! where an EXP marker says so (J.1.1.2: each new sample is the mean of its two neighbours,
//! rounded down; the last row or column is repeated).
//!
//! Reconstructions are kept as unclamped integers. DCT frames are inverse-transformed with the
//! same `jidctint` arithmetic as the rest of the decoder but without the range limit, and only
//! the final image is clamped to the sample range. Lossless differential frames add modulo 2^16
//! (H.1.2.1). The final image then goes through the same upsampling and colour conversion as a
//! non-hierarchical frame.

use crate::dct::{self, DctDecoder};
use crate::idct::{idct_1d, CONST_BITS};
use crate::lossless::LosslessDecoder;
use crate::markers::{Frame, Process, Tables};
use crate::out::{interleave_row, put_row, Sample, Sink};
use crate::{invalid, Image};
use shl_codec_common::{Photometric, Result};

/// One component's current reconstruction.
struct CompImage {
    w: usize,
    h: usize,
    data: Vec<i32>,
}

pub(crate) struct Hier {
    pub(crate) dhp: Frame,
    images: Vec<Option<CompImage>>,
    /// Whether the last frame was lossless (the output then follows lossless rules).
    last_lossless: bool,
}

/// A frame's decoder, as `markers` holds it.
pub(crate) enum FrameOut<'a> {
    Dct8(&'a DctDecoder<u8>),
    Dct12(&'a DctDecoder<u16>),
    Lossless(&'a LosslessDecoder),
}

impl Hier {
    pub(crate) fn new(dhp: Frame) -> Self {
        let n = dhp.comps.len();
        Self { dhp, images: (0..n).map(|_| None).collect(), last_lossless: false }
    }

    /// Fold a finished frame into the reconstruction. `exp`: the EXP marker before it
    /// (expand horizontally, vertically).
    pub(crate) fn add(&mut self, f: &Frame, out: FrameOut<'_>, t: &Tables, exp: (bool, bool)) -> Result<()> {
        let comps = match out {
            FrameOut::Dct8(d) => dct_raw(d, f, t),
            FrameOut::Dct12(d) => dct_raw(d, f, t),
            FrameOut::Lossless(d) => d.raw(f),
        };
        let lossless = f.process == Process::Lossless;
        for (ci, diff) in comps.into_iter().enumerate() {
            let (cw, ch) = f.comp_size(ci);
            let di = self
                .dhp
                .comps
                .iter()
                .position(|c| c.id == f.comps[ci].id)
                .ok_or_else(|| invalid("hierarchical frame names a component not in the DHP"))?;
            let slot = self.images.get_mut(di).ok_or_else(|| invalid("bad component"))?;
            let next = if f.differential {
                let Some(prev) = slot.as_ref() else {
                    return Err(invalid("differential frame before any frame of its component"));
                };
                let up = expand(prev, exp)?;
                if cw > up.w || ch > up.h {
                    return Err(invalid("hierarchical frame larger than its expanded reference"));
                }
                let mut data = Vec::with_capacity(cw * ch);
                for y in 0..ch {
                    for x in 0..cw {
                        let r = up.data.get(y * up.w + x).copied().unwrap_or(0);
                        let d = diff.get(y * cw + x).copied().unwrap_or(0);
                        data.push(if lossless { r.wrapping_add(d) & 0xFFFF } else { r.saturating_add(d) });
                    }
                }
                CompImage { w: cw, h: ch, data }
            } else {
                CompImage { w: cw, h: ch, data: diff }
            };
            *slot = Some(next);
        }
        self.last_lossless = lossless;
        Ok(())
    }

    /// The final image: every DHP component at its full size, clamped, upsampled to the image
    /// size and colour-converted as a non-hierarchical frame of the last frame's kind would be.
    pub(crate) fn finish(self, t: &Tables, photometric: Photometric, bps: usize) -> Result<Image> {
        let f = &self.dhp;
        let mut comps = Vec::with_capacity(f.comps.len());
        for (ci, img) in self.images.into_iter().enumerate() {
            let img = img.ok_or_else(|| invalid("a DHP component has no frame"))?;
            if (img.w, img.h) != f.comp_size(ci) {
                return Err(invalid("hierarchical image ends smaller than the DHP size"));
            }
            comps.push(img.data);
        }
        let max = (1i32 << f.precision) - 1;
        if self.last_lossless {
            return lossless_out(f, &comps, bps, photometric);
        }
        if bps == 1 && f.precision > 8 {
            return Err(invalid("JPEG precision exceeds Bits Allocated 8"));
        }
        if f.precision <= 8 {
            let c: Vec<Vec<u8>> = comps.iter().map(|d| d.iter().map(|&v| v.clamp(0, max) as u8).collect()).collect();
            dct::render(f, c, t, photometric, bps)
        } else {
            let c: Vec<Vec<u16>> = comps.iter().map(|d| d.iter().map(|&v| v.clamp(0, max) as u16).collect()).collect();
            dct::render(f, c, t, photometric, bps)
        }
    }
}

/// Expand an image 2× in the directions `exp` says (J.1.1.2): each new sample is the mean of
/// its two neighbours, truncated; horizontal first, then vertical between the expanded rows;
/// the last column and row are repeated.
fn expand(img: &CompImage, exp: (bool, bool)) -> Result<CompImage> {
    let (w, h) = (img.w, img.h);
    if w == 0 || h == 0 {
        return Err(invalid("empty hierarchical reference"));
    }
    let at = |x: usize, y: usize| img.data.get(y.min(h - 1) * w + x.min(w - 1)).copied().unwrap_or(0);
    let w2 = if exp.0 { 2 * w } else { w };
    let h2 = if exp.1 { 2 * h } else { h };
    let row = |y: usize| -> Vec<i32> {
        (0..w2)
            .map(|x| {
                if !exp.0 {
                    at(x, y)
                } else if x % 2 == 0 {
                    at(x / 2, y)
                } else {
                    (at(x / 2, y) + at(x / 2 + 1, y)) >> 1
                }
            })
            .collect()
    };
    let mut data = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        if !exp.1 {
            data.extend(row(y));
        } else if y % 2 == 0 {
            data.extend(row(y / 2));
        } else {
            let (a, b) = (row(y / 2), row((y / 2 + 1).min(h - 1)));
            data.extend(a.iter().zip(&b).map(|(&a, &b)| (a + b) >> 1));
        }
    }
    Ok(CompImage { w: w2, h: h2, data })
}

/// Inverse DCT of every block of a buffered frame, without the range limit: the differences of a
/// differential frame, or the samples (level shift added) of a first frame. Cropped to each
/// component's size.
fn dct_raw<T: Sample>(d: &DctDecoder<T>, f: &Frame, t: &Tables) -> Vec<Vec<i32>> {
    let pass1: u32 = if f.precision == 8 { 2 } else { 1 };
    let shift = if f.differential { 0 } else { 1i32 << (f.precision - 1) };
    let Some(coefs) = d.coefs.as_ref() else { return vec![] };
    coefs
        .iter()
        .enumerate()
        .map(|(ci, cp)| {
            let (cw, ch) = f.comp_size(ci);
            let q = d.latched.get(ci).copied().flatten().or(t.quant[f.comps[ci].tq]).unwrap_or([0; 64]);
            let mut out = vec![0i32; cw * ch];
            for by in 0..ch.div_ceil(8).min(cp.bh) {
                for bx in 0..cw.div_ceil(8).min(cp.bw) {
                    let Some(b) = cp.block(bx, by) else { continue };
                    let px = idct_raw(b, &q, pass1);
                    for r in 0..8 {
                        let y = by * 8 + r;
                        if y >= ch {
                            break;
                        }
                        for c in 0..8 {
                            let x = bx * 8 + c;
                            if x >= cw {
                                break;
                            }
                            out[y * cw + x] = px[r * 8 + c].saturating_add(shift);
                        }
                    }
                }
            }
            out
        })
        .collect()
}

/// `jidctint` in 64-bit arithmetic with no range limit or level shift.
fn idct_raw(b: &[i16; 64], q: &[u16; 64], pass1: u32) -> [i32; 64] {
    let descale = |x: i64, n: u32| (x + (1i64 << (n - 1))) >> n;
    let mut ws = [0i64; 64];
    for col in 0..8 {
        let o = idct_1d(core::array::from_fn(|r| i64::from(b[r * 8 + col]) * i64::from(q[r * 8 + col])));
        for r in 0..8 {
            ws[r * 8 + col] = descale(o[r], CONST_BITS - pass1);
        }
    }
    let mut out = [0i32; 64];
    for row in 0..8 {
        let o = idct_1d(core::array::from_fn(|c| ws[row * 8 + c]));
        for c in 0..8 {
            out[row * 8 + c] = descale(o[c], CONST_BITS + pass1 + 3).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        }
    }
    out
}

/// Lossless output (as `LosslessDecoder::finish`): samples as reconstructed, subsampled
/// components replicated.
fn lossless_out(f: &Frame, comps: &[Vec<i32>], bps: usize, photometric: Photometric) -> Result<Image> {
    let (w, h) = (f.width, f.height);
    let n = f.comps.len();
    if bps == 1 && f.precision > 8 {
        return Err(invalid("JPEG precision exceeds Bits Allocated 8"));
    }
    let mut sink = Sink::new(w, h, n, bps)?;
    let mut rows: Vec<Vec<u16>> = vec![vec![0u16; w]; n];
    for y in 0..h {
        for (ci, row) in rows.iter_mut().enumerate() {
            let c = &f.comps[ci];
            let (hf, vf) = ((f.hmax / c.h).max(1), (f.vmax / c.v).max(1));
            let (cw, ch) = f.comp_size(ci);
            let sy = (y / vf).min(ch.saturating_sub(1));
            for (x, o) in row.iter_mut().enumerate() {
                let sx = (x / hf).min(cw.saturating_sub(1));
                *o = (comps[ci].get(sy * cw + sx).copied().unwrap_or(0) & 0xFFFF) as u16;
            }
        }
        if n == 1 {
            put_row(&rows[0], sink.row(y), bps);
        } else {
            let srcs: Vec<&[u16]> = rows.iter().map(|r| &r[..]).collect();
            interleave_row(&srcs, sink.row(y), bps);
        }
    }
    let same_sampling = f.comps.iter().all(|c| c.h == f.comps[0].h && c.v == f.comps[0].v);
    let subsampled_label =
        matches!(photometric, Photometric::YbrFull422 | Photometric::YbrPartial422 | Photometric::YbrPartial420);
    let rgb = n == 3 && same_sampling && subsampled_label;
    Ok(Image { width: w, height: h, components: n, data: sink.into_data(), rgb, retry_cornell: false, bad_codes: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expansion_truncates_each_direction() {
        // T.81 J.1.1.2: horizontal means first, then vertical means of those. The mean of all
        // four neighbours (Richter's libjpeg) would give 2 at (1, 1).
        let img = CompImage { w: 2, h: 2, data: vec![1, 2, 2, 3] };
        let up = expand(&img, (true, true)).unwrap();
        assert_eq!((up.w, up.h), (4, 4));
        assert_eq!(up.data, vec![1, 1, 2, 2, 1, 1, 2, 2, 2, 2, 3, 3, 2, 2, 3, 3]);
        let h = expand(&img, (true, false)).unwrap();
        assert_eq!(h.data, vec![1, 1, 2, 2, 2, 2, 3, 3]);
    }
}
