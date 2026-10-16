//! Sequential DCT decoding (processes 1, 2 and 4: 8 and 12-bit, Huffman).
//!
//! Each block is decoded, then dequantised and inverse-transformed at once (sequential scans
//! never refine coefficients), into a padded per-component plane (`u8` samples for 8-bit
//! precision, `u16` for 12-bit). Upsampling and colour conversion then run one output row at a
//! time, straight into the output bytes. Vector kernels are in `simd.rs`. Both follow
//! IJG libjpeg 6b defaults exactly: `jidctint.c` (see `idct.rs`), `jdsample.c` fancy upsampling,
//! `jdcolor.c`.

use crate::bits::{extend, BitReader};
use crate::coef::{self, CoefPlane};
use crate::huffman::HuffTable;
use crate::idct;
use crate::markers::{Frame, Scan, Tables, ZIGZAG};
use crate::out::{put_row, Sample, Sink};
use crate::simd::Kernels;
use crate::{invalid, unsupported, Image};
use shl_codec_common::{Photometric, Result};

/// One component's samples, `T` = `u8` for 8-bit precision and `u16` for 12-bit.
pub(crate) struct Plane<T> {
    data: Vec<T>,
    stride: usize,
    quant: Option<[u16; 64]>,
    /// Samples per block side in this plane: 8, or 4, 2 or 1 for a reduced decode.
    bs: usize,
}

/// Samples per block side for each component at scale 1/2^`scale_log2`, as libjpeg-turbo's
/// `jpeg_calc_output_dimensions` chooses them: the smallest size is 8 >> scale_log2, and a
/// subsampled component gets a larger IDCT (up to 8) when that makes up its subsampling, so it
/// needs less or no upsampling. At full size every component uses 8.
pub(crate) fn block_sizes(f: &Frame, scale_log2: u8) -> Vec<usize> {
    let min = 8usize >> scale_log2.min(3);
    f.comps
        .iter()
        .map(|c| {
            let mut s = min;
            while s < 8 && (f.hmax * min).is_multiple_of(c.h * s * 2) && (f.vmax * min).is_multiple_of(c.v * s * 2) {
                s *= 2;
            }
            s
        })
        .collect()
}

pub(crate) struct DctDecoder<T> {
    planes: Vec<Plane<T>>,
    /// Coefficient-buffered frames (progressive, arithmetic, hierarchical): the coefficients,
    /// transformed in `finish` (or by `hier`). None for sequential Huffman frames, whose blocks
    /// are transformed as they are decoded.
    pub(crate) coefs: Option<Vec<CoefPlane>>,
    /// Quantisation tables latched at each component's first scan (buffered frames).
    pub(crate) latched: Vec<Option<[u16; 64]>>,
    /// Output scale is 1/2^scale_log2 (0 for a full decode).
    scale_log2: u8,
    /// libjpeg's post-IDCT range-limit table, indexed by `value & (len - 1)`.
    range: Vec<u16>,
    pass1_bits: u32,
    max: i32,
    kernels: Kernels,
}

impl<T: Sample> DctDecoder<T> {
    /// `buffered`: keep coefficients until `finish` (needed by every process except sequential
    /// Huffman). `samples`: allocate the sample planes (false for hierarchical frames, which
    /// `hier` reconstructs from the coefficients).
    pub(crate) fn new(f: &Frame, scale_log2: u8, buffered: bool, samples: bool, kernels: Kernels) -> Result<Self> {
        let (mx, my) = f.mcus(8);
        let mut planes = Vec::with_capacity(f.comps.len());
        for (c, bs) in f.comps.iter().zip(block_sizes(f, scale_log2)) {
            let stride = mx * c.h * bs;
            let rows = my * c.v * bs;
            let n = if samples { stride.checked_mul(rows).ok_or_else(|| invalid("image too large"))? } else { 0 };
            planes.push(Plane { data: vec![T::default(); n], stride, quant: None, bs });
        }
        let coefs = if buffered { Some(coef::planes(f)?) } else { None };
        let max: i32 = (1 << f.precision) - 1;
        Ok(Self {
            planes,
            coefs,
            latched: vec![None; f.comps.len()],
            scale_log2,
            range: idct::range_table(max),
            pass1_bits: if f.precision == 8 { 2 } else { 1 },
            max,
            kernels,
        })
    }

    pub(crate) fn decode_scan(&mut self, data: &[u8], scan: &Scan, t: &Tables, f: &Frame) -> Result<()> {
        if let Some(coefs) = self.coefs.as_mut() {
            for sc in &scan.comps {
                if self.latched[sc.index].is_none() {
                    // libjpeg latches the quantisation table at the component's first scan.
                    let tq = f.comps[sc.index].tq;
                    self.latched[sc.index] =
                        Some(t.quant[tq].ok_or_else(|| invalid("component uses an undefined quantisation table"))?);
                }
            }
            return coef::decode_scan(coefs, data, scan, t, f);
        }
        // At 1/8 with every component on 1×1 blocks only DC values are used, so AC coefficients
        // are decoded (they must be, to find the next block) but not stored.
        if scan.comps.iter().all(|sc| self.planes[sc.index].bs == 1) {
            self.decode_scan_with::<true>(data, scan, t, f)
        } else {
            self.decode_scan_with::<false>(data, scan, t, f)
        }
    }

    fn decode_scan_with<const DC_ONLY: bool>(&mut self, data: &[u8], scan: &Scan, t: &Tables, f: &Frame) -> Result<()> {
        // Sequential scans: libjpeg only warns when Ss/Se/Ah/Al are not 0/63/0/0 and decodes all
        // 64 coefficients regardless, so we do the same (pydicom's JPEG-lossy.dcm has Se = 0).
        let mut dcs: Vec<&HuffTable> = Vec::with_capacity(scan.comps.len());
        let mut acs: Vec<&HuffTable> = Vec::with_capacity(scan.comps.len());
        let mut quants: Vec<[i32; 64]> = Vec::with_capacity(scan.comps.len());
        for sc in &scan.comps {
            dcs.push(t.dc_table(sc.td)?);
            acs.push(t.ac_table(sc.ta)?);
            let p = &mut self.planes[sc.index];
            if p.quant.is_none() {
                // libjpeg latches the quantisation table at the component's first scan.
                let tq = f.comps[sc.index].tq;
                p.quant = Some(t.quant[tq].ok_or_else(|| invalid("component uses an undefined quantisation table"))?);
            }
            quants.push(p.quant.unwrap_or([0; 64]).map(i32::from));
        }
        let mut r = BitReader::new(data);
        let mut pred = [0i32; 4];
        let ri = t.restart_interval;
        let mut blk = [0i32; 64];

        if scan.comps.len() == 1 {
            let ci = scan.comps[0].index;
            let (cw, ch) = f.comp_size(ci);
            let (bw, bh) = (cw.div_ceil(8), ch.div_ceil(8));
            for i in 0..bw * bh {
                if ri > 0 && i > 0 && i % ri == 0 {
                    r.restart();
                    pred = [0; 4];
                }
                let has_ac = decode_block::<DC_ONLY>(&mut r, dcs[0], acs[0], &mut pred[0], &mut blk)?;
                let bs = self.planes[ci].bs;
                self.idct_into(ci, has_ac, &blk, &quants[0], (i % bw) * bs, (i / bw) * bs);
            }
        } else {
            let (mx, my) = f.mcus(8);
            for m in 0..mx * my {
                if ri > 0 && m > 0 && m % ri == 0 {
                    r.restart();
                    pred = [0; 4];
                }
                let (bx0, by0) = (m % mx, m / mx);
                for (k, sc) in scan.comps.iter().enumerate() {
                    let c = &f.comps[sc.index];
                    let bs = self.planes[sc.index].bs;
                    for v in 0..c.v {
                        for h in 0..c.h {
                            let has_ac = decode_block::<DC_ONLY>(&mut r, dcs[k], acs[k], &mut pred[k], &mut blk)?;
                            let (bx, by) = ((bx0 * c.h + h) * bs, (by0 * c.v + v) * bs);
                            self.idct_into(sc.index, has_ac, &blk, &quants[k], bx, by);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Dequantise and inverse-transform one block into component `ci`'s plane at (x, y).
    #[inline]
    fn idct_into(&mut self, ci: usize, has_ac: bool, blk: &[i32; 64], q: &[i32; 64], x: usize, y: usize) {
        let pass1 = self.pass1_bits;
        let p = &mut self.planes[ci];
        let off = y * p.stride + x;
        let Some(out) = p.data.get_mut(off..) else { return };
        if p.bs != 8 {
            // Reduced decode (`jidctred.c`).
            let bs = p.bs;
            // 1×1 uses the DC coefficient only, so every block takes the flat path.
            if has_ac && bs > 1 {
                self.kernels.idct_reduced(bs, blk, q, pass1, self.max, &self.range, out, p.stride);
            } else {
                let v = T::from_u16(idct::dc_only_reduced(bs, blk[0] * q[0], pass1, &self.range));
                for row in out.chunks_mut(p.stride).take(bs) {
                    if let Some(d) = row.get_mut(..bs) {
                        d.fill(v);
                    }
                }
            }
        } else if has_ac {
            self.kernels.idct(blk, q, pass1, self.max, &self.range, out, p.stride);
        } else {
            // A flat block. Coefficients are 16-bit and quantisers 16-bit, so the product fits.
            let v = T::from_u16(idct::dc_only(blk[0] * q[0], pass1, &self.range));
            for row in out.chunks_mut(p.stride).take(8) {
                if let Some(d) = row.get_mut(..8) {
                    d.fill(v);
                }
            }
        }
    }

    /// Inverse-transform every buffered block into the sample planes.
    fn transform_buffered(&mut self, f: &Frame, t: &Tables) {
        let Some(coefs) = self.coefs.take() else { return };
        for (ci, cp) in coefs.iter().enumerate() {
            // A component no scan included keeps zero coefficients (mid-grey, as libjpeg).
            let q = self.latched[ci].or(t.quant[f.comps[ci].tq]).unwrap_or([0; 64]).map(i32::from);
            let bs = self.planes[ci].bs;
            let mut blk = [0i32; 64];
            for by in 0..cp.bh {
                for bx in 0..cp.bw {
                    let Some(b) = cp.block(bx, by) else { continue };
                    let mut has_ac = false;
                    for (o, &c) in blk.iter_mut().zip(b.iter()) {
                        *o = i32::from(c);
                    }
                    for &c in &b[1..] {
                        has_ac |= c != 0;
                    }
                    self.idct_into(ci, has_ac, &blk, &q, bx * bs, by * bs);
                }
            }
        }
    }

    pub(crate) fn finish(mut self, f: &Frame, t: &Tables, photometric: Photometric, bps: usize) -> Result<Image> {
        self.transform_buffered(f, t);
        let s = self.scale_log2;
        // libjpeg's output size: ceil(X · min_size / 8), which is ceil(X / 2^s).
        let (w, h) = (f.width.div_ceil(1 << s), f.height.div_ceil(1 << s));
        let n = f.comps.len();
        let ups: Vec<Upsampler> = if s == 0 {
            (0..n).map(|ci| Upsampler::new(f, ci)).collect::<Result<_>>()?
        } else {
            (0..n).map(|ci| Upsampler::scaled(f, ci, s, self.planes[ci].bs)).collect::<Result<_>>()?
        };
        if bps == 1 && f.precision > 8 {
            return Err(invalid("JPEG precision exceeds Bits Allocated 8"));
        }
        let max: i32 = (1 << f.precision) - 1;
        let ycc = n == 3 && is_ycc(t, photometric);
        let mut sink = Sink::new(w, h, n, bps)?;
        let job = RowJob { planes: &self.planes, ups: &ups, w, h, ycc, bps, max };
        self.kernels.rows(&job, &mut sink);
        // Three components are RGB after this point whichever way they were coded, so the CLI must
        // not convert again even if the dataset says YBR (Adobe transform 0 overrides the label).
        Ok(Image { width: w, height: h, components: n, data: sink.into_data(), rgb: n == 3, retry_cornell: false, bad_codes: 0 })
    }
}

/// Upsample, colour-convert and output a hierarchical image whose components are already
/// reconstructed: `comps[ci]` is component `ci` of `f` at its `comp_size`, clamped.
pub(crate) fn render<T: Sample>(f: &Frame, comps: Vec<Vec<T>>, t: &Tables, photometric: Photometric, bps: usize, kernels: Kernels) -> Result<Image> {
    let n = f.comps.len();
    let planes: Vec<Plane<T>> = comps
        .into_iter()
        .enumerate()
        .map(|(ci, data)| Plane { data, stride: f.comp_size(ci).0, quant: None, bs: 8 })
        .collect();
    let ups: Vec<Upsampler> = (0..n).map(|ci| Upsampler::new(f, ci)).collect::<Result<_>>()?;
    let (w, h) = (f.width, f.height);
    let max: i32 = (1 << f.precision) - 1;
    let ycc = n == 3 && is_ycc(t, photometric);
    let mut sink = Sink::new(w, h, n, bps)?;
    let job = RowJob { planes: &planes, ups: &ups, w, h, ycc, bps, max };
    kernels.rows(&job, &mut sink);
    Ok(Image { width: w, height: h, components: n, data: sink.into_data(), rgb: n == 3, retry_cornell: false, bad_codes: 0 })
}

/// Upsampling, colour conversion and output of every row: the second half of decoding.
/// `#[inline(always)]` so the SIMD module can compile it again for a wider instruction set.
pub(crate) struct RowJob<'a, T> {
    planes: &'a [Plane<T>],
    ups: &'a [Upsampler],
    w: usize,
    h: usize,
    ycc: bool,
    bps: usize,
    max: i32,
}

impl<T: Sample> RowJob<'_, T> {
    #[inline(always)]
    pub(crate) fn run(&self, sink: &mut Sink) {
        let (w, n, bps, max) = (self.w, self.planes.len(), self.bps, self.max);
        let mut scratch: Vec<Vec<T>> = self.ups.iter().map(|u| vec![T::default(); u.scratch_len()]).collect();
        let mut sums = vec![0i32; w];
        for y in 0..self.h {
            for ((u, p), s) in self.ups.iter().zip(self.planes).zip(scratch.iter_mut()) {
                u.row(p, y, s, &mut sums);
            }
            let src = |ci: usize| -> &[T] {
                let p = &self.planes[ci];
                if self.ups[ci].kind == Up::Copy {
                    &p.data[y * p.stride..y * p.stride + w]
                } else {
                    &scratch[ci][..w]
                }
            };
            let out = sink.row(y);
            if self.ycc {
                ycc_row(src(0), src(1), src(2), out, bps, max);
            } else if n == 1 {
                put_row(src(0), out, bps);
            } else {
                let srcs: Vec<&[T]> = (0..n).map(src).collect();
                crate::out::interleave_row(&srcs, out, bps);
            }
        }
    }
}

/// Whether a 3-component frame holds YCbCr. The codestream's own markers win: JFIF means YCbCr,
/// Adobe APP14 transform 0 means RGB and any other transform YCbCr (libjpeg's rule). With neither
/// marker, the DICOM photometric decides; libjpeg would guess from component identifiers, but
/// pylibjpeg, gdcm and dcmtk all follow the photometric there (see FORMAT.md rulings).
fn is_ycc(t: &Tables, photometric: Photometric) -> bool {
    if t.jfif {
        return true;
    }
    if let Some(tr) = t.adobe_transform {
        return tr != 0;
    }
    matches!(
        photometric,
        Photometric::YbrFull | Photometric::YbrFull422 | Photometric::YbrPartial422 | Photometric::YbrPartial420
    )
}

/// Decode one block's coefficients into `blk` (natural order, not dequantised). Returns whether
/// any AC coefficient was coded; when none was, the block is flat. `DC_ONLY`: decode the AC
/// coefficients but store only `blk[0]` (the rest of `blk` is left as it was).
#[inline]
fn decode_block<const DC_ONLY: bool>(r: &mut BitReader, dc: &HuffTable, ac: &HuffTable, pred: &mut i32, blk: &mut [i32; 64]) -> Result<bool> {
    if !DC_ONLY {
        *blk = [0; 64];
    }
    // The bit buffer stays in registers for the block. Each symbol starts with 32 bits
    // buffered: a code (<= 16 bits) and its value bits (<= 16) are then read without checks.
    let mut b = r.ensure32(r.load());
    let peek = b.peek();
    let f = dc.fast[peek];
    let diff = if f != 0 {
        b.consume((f & 0xFF) as u32);
        f >> 8
    } else {
        let e = dc.lookup[peek];
        let s = if e != 0 {
            b.consume(u32::from(e >> 8));
            u32::from(e & 0xFF)
        } else {
            let (nb, s) = b.huff_long(dc)?;
            b = nb;
            u32::from(s)
        };
        if s > 16 {
            return Err(invalid("DC difference category > 16"));
        }
        extend(b.take(s), s)
    };
    *pred = pred.wrapping_add(diff);
    // libjpeg stores coefficients as 16-bit JCOEF.
    blk[0] = i32::from(*pred as i16);
    let mut k = 1usize;
    while k < 64 {
        b = r.ensure32(b);
        let peek = b.peek();
        let f = ac.fast[peek];
        if f != 0 {
            // Code and value bits in one lookup.
            b.consume((f & 0xFF) as u32);
            k += ((f >> 8) & 0xFF) as usize;
            if !DC_ONLY {
                blk[ZIGZAG[k]] = f >> 16;
            }
        } else {
            let e = ac.lookup[peek];
            let rs = if e != 0 {
                b.consume(u32::from(e >> 8));
                (e & 0xFF) as u8
            } else {
                let (nb, rs) = b.huff_long(ac)?;
                b = nb;
                rs
            };
            let run = usize::from(rs >> 4);
            let s = u32::from(rs & 15);
            if s == 0 {
                if run == 15 {
                    k += 16;
                    continue;
                }
                break;
            }
            k += run;
            // s <= 15, so the value fits in i16 as libjpeg stores it.
            let v = extend(b.take(s), s);
            if !DC_ONLY {
                blk[ZIGZAG[k]] = v;
            }
        }
        k += 1;
    }
    r.store(b);
    // A run of ZRLs with no value also reports true; the full IDCT of such a block is exact.
    Ok(k > 1)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Up {
    /// Full resolution: the plane row is used as is.
    Copy,
    H2V1Fancy,
    H2V2Fancy,
    /// Integer replication `hf` × `vf` (libjpeg's `int_upsample`, also used for narrow images).
    Box { hf: usize, vf: usize },
}

/// libjpeg 6b's default upsampler for one component.
pub(crate) struct Upsampler {
    kind: Up,
    /// Component width and height before upsampling.
    cw: usize,
    ch: usize,
}

impl Upsampler {
    fn new(f: &Frame, ci: usize) -> Result<Self> {
        let c = &f.comps[ci];
        if !f.hmax.is_multiple_of(c.h) || !f.vmax.is_multiple_of(c.v) {
            return Err(unsupported("fractional sampling factors"));
        }
        let (hf, vf) = (f.hmax / c.h, f.vmax / c.v);
        let (cw, ch) = f.comp_size(ci);
        let kind = match (hf, vf) {
            (1, 1) => Up::Copy,
            (2, 1) if cw > 2 => Up::H2V1Fancy,
            (2, 2) if cw > 2 => Up::H2V2Fancy,
            _ => Up::Box { hf, vf },
        };
        Ok(Self { kind, cw, ch })
    }

    /// libjpeg-turbo's upsampler for component `ci` in a reduced decode whose blocks for this
    /// component are `bs` samples on a side (`jinit_upsampler` with `_DCT_scaled_size` = `bs`).
    /// Differences from the full-size choice: the factors are what the larger IDCT left over,
    /// and at 1/8 (one sample per block) libjpeg-turbo turns fancy upsampling off. One known
    /// difference: libjpeg-turbo has a fancy 1×2 (h1v2, 4:4:0) upsampler; this replicates rows
    /// there, as the full-size path (IJG 6b) does. No corpus case has 4:4:0.
    fn scaled(f: &Frame, ci: usize, scale_log2: u8, bs: usize) -> Result<Self> {
        let c = &f.comps[ci];
        let min = 8usize >> scale_log2.min(3);
        let (h_in, v_in) = (c.h * bs / min, c.v * bs / min);
        if h_in == 0 || v_in == 0 || !f.hmax.is_multiple_of(h_in) || !f.vmax.is_multiple_of(v_in) {
            return Err(unsupported("fractional sampling factors"));
        }
        let (hf, vf) = (f.hmax / h_in, f.vmax / v_in);
        // downsampled_width = ceil(X · h · bs / (hmax · 8)), and the same for height.
        let cw = (f.width * c.h * bs).div_ceil(f.hmax * 8);
        let ch = (f.height * c.v * bs).div_ceil(f.vmax * 8);
        let fancy = min > 1;
        let kind = match (hf, vf) {
            (1, 1) => Up::Copy,
            (2, 1) if fancy && cw > 2 => Up::H2V1Fancy,
            (2, 2) if fancy && cw > 2 => Up::H2V2Fancy,
            _ => Up::Box { hf, vf },
        };
        Ok(Self { kind, cw, ch })
    }

    fn scratch_len(&self) -> usize {
        match self.kind {
            Up::Copy => 0,
            Up::H2V1Fancy | Up::H2V2Fancy => 2 * self.cw,
            Up::Box { hf, .. } => hf * self.cw,
        }
    }

    /// Fill `out` (at least the image width) with output row `y` of this component.
    #[inline(always)]
    fn row<T: Sample>(&self, p: &Plane<T>, y: usize, out: &mut [T], sums: &mut [i32]) {
        let cw = self.cw;
        let row = |y: usize| &p.data[y * p.stride..y * p.stride + cw];
        match self.kind {
            Up::Copy => {}
            Up::H2V1Fancy => h2v1_fancy(row(y), out),
            Up::H2V2Fancy => {
                let (cy, v) = (y / 2, y % 2);
                let near = if v == 0 { cy.saturating_sub(1) } else { (cy + 1).min(self.ch - 1) };
                let (r0, r1) = (row(cy), row(near));
                let sums = &mut sums[..cw];
                for ((s, &a), &b) in sums.iter_mut().zip(r0).zip(r1) {
                    *s = 3 * a.into() + b.into();
                }
                h2v2_fancy(sums, out);
            }
            Up::Box { hf, vf } => {
                let r = row(y / vf);
                for (o, &s) in out.chunks_exact_mut(hf).zip(r) {
                    o.fill(s);
                }
            }
        }
    }
}

/// `h2v1_fancy_upsample` (triangle filter, alternating rounding). `inp.len() > 2`.
#[inline(always)]
fn h2v1_fancy<T: Sample>(inp: &[T], out: &mut [T]) {
    let n = inp.len();
    let out = &mut out[..2 * n];
    let s = |i: usize| inp[i].into();
    let t = |v: i32| T::from_u16(v as u16);
    out[0] = inp[0];
    out[1] = t((s(0) * 3 + s(1) + 2) >> 2);
    // Inputs 1..n-1. The wasm kernel does a vector-sized prefix; the zip form below is what
    // LLVM auto-vectorises well on x86.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    let start = crate::simd::wasm::h2v1_mid(inp, out);
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    let start = 1;
    let mid = &mut out[2 * start..2 * n - 2];
    for (o, w) in mid.chunks_exact_mut(2).zip(inp[start - 1..].windows(3)) {
        let v = w[1].into() * 3;
        o[0] = t((v + w[0].into() + 1) >> 2);
        o[1] = t((v + w[2].into() + 2) >> 2);
    }
    let i = n - 1;
    out[2 * i] = t((s(i) * 3 + s(i - 1) + 1) >> 2);
    out[2 * i + 1] = inp[i];
}

/// One output row of `h2v2_fancy_upsample`, from column sums 3·nearer + farther. `sums.len() > 2`.
#[inline(always)]
fn h2v2_fancy<T: Sample>(sums: &[i32], out: &mut [T]) {
    let n = sums.len();
    let out = &mut out[..2 * n];
    let t = |v: i32| T::from_u16(v as u16);
    out[0] = t((sums[0] * 4 + 8) >> 4);
    out[1] = t((sums[0] * 3 + sums[1] + 7) >> 4);
    for (o, w) in out[2..2 * n - 2].chunks_exact_mut(2).zip(sums.windows(3)) {
        let v = w[1] * 3;
        o[0] = t((v + w[0] + 8) >> 4);
        o[1] = t((v + w[2] + 7) >> 4);
    }
    let i = n - 1;
    out[2 * i] = t((sums[i] * 3 + sums[i - 1] + 8) >> 4);
    out[2 * i + 1] = t((sums[i] * 4 + 7) >> 4);
}

/// `jdcolor.c` YCbCr→RGB with 16 fractional bits. libjpeg reads these products from tables
/// (`Cr_r_tab` and friends); computing them gives the same integers, because each table entry is
/// exactly `(FIX(k) * x + ONE_HALF) >> 16` (or, for G, the two unshifted products summed before
/// the shift), and |x| ≤ 2048 keeps every product inside i32.
pub(crate) const FIX_1_40200: i32 = 91881;
pub(crate) const FIX_1_77200: i32 = 116130;
pub(crate) const FIX_0_71414: i32 = 46802;
pub(crate) const FIX_0_34414: i32 = 22554;
const ONE_HALF: i32 = 1 << 15;

#[inline(always)]
pub(crate) fn ycc_px(y: i32, cb: i32, cr: i32) -> (i32, i32, i32) {
    let r = y + ((FIX_1_40200 * cr + ONE_HALF) >> 16);
    let g = y + ((-FIX_0_34414 * cb - FIX_0_71414 * cr + ONE_HALF) >> 16);
    let b = y + ((FIX_1_77200 * cb + ONE_HALF) >> 16);
    (r, g, b)
}

/// One row of YCbCr→RGB, interleaved into `out` at `bps` bytes per sample.
#[inline(always)]
fn ycc_row<T: Sample>(y: &[T], cb: &[T], cr: &[T], out: &mut [u8], bps: usize, max: i32) {
    let center = (max + 1) / 2;
    let lim = |v: i32| v.clamp(0, max);
    match bps {
        1 => {
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            let done = crate::simd::wasm::ycc_row8(y, cb, cr, out);
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            let done = 0;
            let (y, cb, cr, out) = (&y[done..], &cb[done..], &cr[done..], &mut out[3 * done..]);
            for (((o, &y), &cb), &cr) in out.chunks_exact_mut(3).zip(y).zip(cb).zip(cr) {
                let (r, g, b) = ycc_px(y.into(), cb.into() - center, cr.into() - center);
                o[0] = lim(r) as u8;
                o[1] = lim(g) as u8;
                o[2] = lim(b) as u8;
            }
        }
        _ => {
            let mut tmp = [0u16; 3];
            for (((o, &y), &cb), &cr) in out.chunks_exact_mut(3 * bps).zip(y).zip(cb).zip(cr) {
                let (r, g, b) = ycc_px(y.into(), cb.into() - center, cr.into() - center);
                tmp[0] = lim(r) as u16;
                tmp[1] = lim(g) as u16;
                tmp[2] = lim(b) as u16;
                put_row(&tmp, o, bps);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `jdcolor.c`'s tables, as libjpeg builds them, to check `ycc_px` against.
    struct YccTables {
        cr_r: Vec<i32>,
        cb_b: Vec<i32>,
        cr_g: Vec<i64>,
        cb_g: Vec<i64>,
        max: i32,
    }

    impl YccTables {
        fn new(max: i32) -> Self {
            const ONE_HALF: i64 = 1 << 15;
            let fix = |x: f64| (x * 65536.0 + 0.5) as i64;
            let center = (max + 1) / 2;
            let xs = (0..=max).map(|i| i64::from(i - center));
            Self {
                cr_r: xs.clone().map(|x| ((fix(1.40200) * x + ONE_HALF) >> 16) as i32).collect(),
                cb_b: xs.clone().map(|x| ((fix(1.77200) * x + ONE_HALF) >> 16) as i32).collect(),
                cr_g: xs.clone().map(|x| -fix(0.71414) * x).collect(),
                cb_g: xs.map(|x| -fix(0.34414) * x + ONE_HALF).collect(),
                max,
            }
        }

        fn convert(&self, y: u16, cb: u16, cr: u16) -> (u16, u16, u16) {
            let (y, cb, cr) = (i32::from(y), usize::from(cb), usize::from(cr));
            let lim = |v: i32| v.clamp(0, self.max) as u16;
            let r = lim(y + self.cr_r[cr]);
            let g = lim(y + ((self.cb_g[cb] + self.cr_g[cr]) >> 16) as i32);
            let b = lim(y + self.cb_b[cb]);
            (r, g, b)
        }
    }

    /// The regrouping the wasm simd128 colour kernel (`simd::wasm::ycc8`) relies on: for 8-bit
    /// chroma, each term (k·x + 2^15) >> 16 equals j·x + ((k'·x + 2^15) >> 16) with k = j·2^16 + k'.
    #[test]
    fn ycc_terms_regrouped_for_16_bit_lanes() {
        for cb in -128i32..128 {
            for cr in -128i32..128 {
                let (r, g, b) = ycc_px(0, cb, cr);
                assert_eq!(r, cr + ((26345 * cr + (2 << 14)) >> 16), "cr {cr}");
                assert_eq!(g, ((-FIX_0_34414 * cb - 14034 * cr) + (-(1 << 15) * cr + (2 << 14))) >> 16, "cb {cb} cr {cr}");
                assert_eq!(b, 2 * cb + ((-14942 * cb + (2 << 14)) >> 16), "cb {cb}");
            }
        }
    }

    #[test]
    fn ycc_arithmetic_matches_tables() {
        let fix = |x: f64| (x * 65536.0 + 0.5) as i32;
        assert_eq!(
            [FIX_1_40200, FIX_1_77200, FIX_0_71414, FIX_0_34414],
            [fix(1.40200), fix(1.77200), fix(0.71414), fix(0.34414)]
        );
        for max in [255, 4095] {
            let t = YccTables::new(max);
            let n = (max as usize) + 1;
            let bps = if max == 255 { 1 } else { 2 };
            let step = if max == 255 { 1 } else { 13 };
            let crs: Vec<u16> = (0..=max as u16).collect();
            let mut out = vec![0u8; 3 * n * bps];
            for y in (0..=max).step_by(step) {
                for cb in (0..=max).step_by(step) {
                    ycc_row(&vec![y as u16; n], &vec![cb as u16; n], &crs, &mut out, bps, max);
                    for cr in 0..=max as usize {
                        let i = cr * 3 * bps;
                        let get = |k: usize| {
                            if bps == 1 {
                                u16::from(out[i + k])
                            } else {
                                u16::from_le_bytes([out[i + 2 * k], out[i + 2 * k + 1]])
                            }
                        };
                        let want = t.convert(y as u16, cb as u16, cr as u16);
                        assert_eq!((get(0), get(1), get(2)), want, "y {y} cb {cb} cr {cr} max {max}");
                    }
                }
            }
        }
        let t = YccTables::new(255);
        assert_eq!(t.convert(100, 128, 128), (100, 100, 100));
        assert_eq!(t.convert(255, 0, 255), (255, 208, 28));
    }

    #[test]
    fn fancy_upsampling_vectors() {
        let mut out = [0u16; 8];
        h2v1_fancy(&[0, 100, 200, 40], &mut out);
        assert_eq!(out, [0, 25, 75, 125, 175, 160, 80, 40]);
    }
}
