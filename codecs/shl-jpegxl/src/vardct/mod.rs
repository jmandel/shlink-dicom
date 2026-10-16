//! VarDCT mode (ISO/IEC 18181-1 Annex I): LF coefficients, AC metadata, HF coefficients,
//! dequantisation and the inverse transforms.

pub mod acs;
pub mod idct;
pub mod quant;

use crate::bits::{bits, bits_offset, unpack_signed, val, BitReader};
use crate::entropy::{ceil_log2, EntropyCode, SymbolReader};
use crate::error::{invalid, Error, Result};
use crate::frame::ModularFrame;
use crate::frame_header::{coeff_order_context, read_permutation_with, FrameDims, FrameHeader};
use crate::modular::{self, Channel, ModularImage, StreamOptions};
use crate::render::Plane;
use crate::simd::F4;
use acs::{AcStrategy, COEFF_ORDER_OFFSET, NUM_STRATEGIES};

const INVALID_ACS: u8 = 0xFF;
const NON_ZERO_BUCKETS: usize = 37;
const ZERO_DENSITY_COUNT: usize = 458;
const QUANT_MAX: i32 = 256;

#[derive(Clone, Debug)]
pub struct BlockCtxMap {
    pub dc_thresholds: [Vec<i32>; 3],
    pub qf_thresholds: Vec<u32>,
    pub ctx_map: Vec<u8>,
    pub num_ctxs: usize,
    pub num_dc_ctxs: usize,
}

const DEFAULT_CTX_MAP: [u8; 39] = [
    0, 1, 2, 2, 3, 3, 4, 5, 6, 6, 6, 6, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14,
    14, 14, 14,
];

impl Default for BlockCtxMap {
    fn default() -> Self {
        BlockCtxMap {
            dc_thresholds: [Vec::new(), Vec::new(), Vec::new()],
            qf_thresholds: Vec::new(),
            ctx_map: DEFAULT_CTX_MAP.to_vec(),
            num_ctxs: 15,
            num_dc_ctxs: 1,
        }
    }
}

impl BlockCtxMap {
    fn read(br: &mut BitReader) -> Result<Self> {
        if br.bit() {
            return Ok(BlockCtxMap::default());
        }
        let mut m = BlockCtxMap { num_dc_ctxs: 1, ..BlockCtxMap::default() };
        for j in 0..3 {
            let n = br.read(4) as usize;
            m.num_dc_ctxs *= n + 1;
            for _ in 0..n {
                m.dc_thresholds[j].push(unpack_signed(br.u32([bits(4), bits_offset(8, 16), bits_offset(16, 272), bits_offset(32, 65808)])));
            }
        }
        let nq = br.read(4) as usize;
        for _ in 0..nq {
            m.qf_thresholds.push(br.u32([bits(2), bits_offset(3, 4), bits_offset(5, 12), bits_offset(8, 44)]) + 1);
        }
        if m.num_dc_ctxs * (nq + 1) > 64 {
            return invalid("block context map too big");
        }
        m.ctx_map = vec![0; 3 * 13 * m.num_dc_ctxs * (nq + 1)];
        m.num_ctxs = crate::entropy::read_context_map_pub(br, &mut m.ctx_map)?;
        if m.num_ctxs > 16 {
            return invalid("block context map has too many contexts");
        }
        Ok(m)
    }

    #[inline(always)]
    fn context(&self, dc_idx: usize, qf: u32, ord: usize, c: usize) -> usize {
        let mut qf_idx = 0;
        for &t in &self.qf_thresholds {
            if qf > t {
                qf_idx += 1;
            }
        }
        let mut idx = if c < 2 { c ^ 1 } else { 2 };
        idx = idx * 13 + ord;
        idx = idx * (self.qf_thresholds.len() + 1) + qf_idx;
        idx = idx * self.num_dc_ctxs + dc_idx;
        usize::from(*self.ctx_map.get(idx).unwrap_or(&0))
    }

    fn num_ac_contexts(&self) -> usize {
        self.num_ctxs * (NON_ZERO_BUCKETS + ZERO_DENSITY_COUNT)
    }

    #[inline(always)]
    fn non_zero_context(&self, non_zeros: u32, block_ctx: usize) -> usize {
        let nz = non_zeros.min(64) as usize;
        let ctx = if nz < 8 { nz } else { 4 + nz / 2 };
        ctx * self.num_ctxs + block_ctx
    }

    fn zero_density_offset(&self, block_ctx: usize) -> usize {
        self.num_ctxs * NON_ZERO_BUCKETS + ZERO_DENSITY_COUNT * block_ctx
    }
}

#[rustfmt::skip]
const COEFF_FREQ_CONTEXT: [u16; 64] = [
    0xBAD, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14,
    15,    15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22,
    23,    23, 23, 23, 24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26,
    27,    27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30,
];
#[rustfmt::skip]
const COEFF_NUM_NONZERO_CONTEXT: [u16; 64] = [
    0xBAD, 0,   31,  62,  62,  93,  93,  93,  93,  123, 123, 123, 123,
    152,   152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180,
    180,   180, 180, 180, 180, 180, 180, 206, 206, 206, 206, 206, 206,
    206,   206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
    206,   206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
];

#[inline(always)]
fn zero_density_context(nonzeros_left: usize, k: usize, covered: usize, log2_covered: usize, prev: usize) -> usize {
    let nz = (nonzeros_left + covered - 1) >> log2_covered;
    let k = k >> log2_covered;
    (usize::from(COEFF_NUM_NONZERO_CONTEXT[nz & 63]) + usize::from(COEFF_FREQ_CONTEXT[k & 63])) * 2 + prev
}

/// Colour correlation (chroma from luma) parameters.
#[derive(Clone, Copy, Debug)]
pub struct Cfl {
    pub color_scale: f32,
    pub base_x: f32,
    pub base_b: f32,
    pub ytox_dc: i32,
    pub ytob_dc: i32,
}

impl Default for Cfl {
    fn default() -> Self {
        Cfl { color_scale: 1.0 / 84.0, base_x: 0.0, base_b: 1.0, ytox_dc: 0, ytob_dc: 0 }
    }
}

impl Cfl {
    fn read(br: &mut BitReader) -> Result<Self> {
        let mut c = Cfl::default();
        if br.bit() {
            return Ok(c);
        }
        let factor = br.u32([val(84), val(256), bits_offset(8, 2), bits_offset(16, 258)]);
        c.color_scale = 1.0 / factor as f32;
        c.base_x = br.f16()?;
        if c.base_x.abs() > 4.0 {
            return invalid("base X correlation");
        }
        c.base_b = br.f16()?;
        if c.base_b.abs() > 4.0 {
            return invalid("base B correlation");
        }
        c.ytox_dc = br.read(8) as i32 - 128;
        c.ytob_dc = br.read(8) as i32 - 128;
        Ok(c)
    }
    pub fn ytox(&self, f: i32) -> f32 {
        self.base_x + f as f32 * self.color_scale
    }
    pub fn ytob(&self, f: i32) -> f32 {
        self.base_b + f as f32 * self.color_scale
    }
}

/// Quantised coefficients of a recompressed JPEG frame, per JPEG component.
pub struct JpegCoeffs {
    /// (width in blocks, height in blocks, 64 coefficients per block in natural order).
    pub comps: Vec<(usize, usize, Vec<i16>)>,
    pub c_map: [usize; 3],
    pub gray: bool,
    scaled_qtable: [i32; 192],
    dcoff: [i32; 3],
    /// The raw table of the frame (3 × 64, JPEG transposed order: index y * 8 + x).
    pub qtable: Vec<i32>,
}

/// VarDCT state of one frame.
pub struct VarDct {
    pub global_scale: u32,
    pub inv_global_scale: f32,
    pub mul_dc: [f32; 3],
    pub block_ctx: BlockCtxMap,
    pub cfl: Cfl,
    pub xb: usize,
    pub yb: usize,
    /// Dequantised LF image per channel ((xb >> hs) × (yb >> vs)).
    pub dc: [Plane; 3],
    pub quant_dc_ctx: Vec<u8>,
    /// (strategy << 1) | first-block flag, or INVALID_ACS.
    pub acs: Vec<u8>,
    pub qf: Vec<i32>,
    pub sharpness: Vec<u8>,
    pub ytox: Vec<i8>,
    pub ytob: Vec<i8>,
    pub ctiles_x: usize,
    pub used_acs: u32,
    tables: Vec<Option<Vec<f32>>>,
    encodings: Vec<quant::Encoding>,
    num_histograms: usize,
    orders: Vec<Vec<u32>>,
    codes: Vec<EntropyCode>,
    pub x_dm: f32,
    pub b_dm: f32,
    pub quant_bias: [f32; 4],
    /// Output samples (X, Y, B or Cb, Y, Cr), padded to whole blocks.
    pub planes: [Plane; 3],
    hs: [usize; 3],
    vs: [usize; 3],
    pub use_lf_frame: bool,
    /// Per-group work buffers, sized for the largest transform in use.
    bufs: Option<(Vec<i32>, Vec<f32>, Vec<f32>)>,
    /// JPEG reconstruction: collect quantised coefficients instead of pixels.
    pub jpeg: Option<JpegCoeffs>,
    ycbcr: bool,
}

pub fn read_lf_global(br: &mut BitReader, fh: &FrameHeader, dims: &FrameDims, lf_dequant: &[f32; 3], quant_bias: [f32; 4], jpeg: bool) -> Result<VarDct> {
    let global_scale = br.u32([bits_offset(11, 1), bits_offset(11, 2049), bits_offset(12, 4097), bits_offset(16, 8193)]);
    let quant_dc = br.u32([val(16), bits_offset(5, 1), bits_offset(8, 1), bits_offset(16, 1)]);
    let block_ctx = BlockCtxMap::read(br)?;
    let cfl = Cfl::read(br)?;
    br.check_end()?;
    let inv_global_scale = (65536.0f64 / f64::from(global_scale)) as f32;
    let inv_quant_dc = inv_global_scale / quant_dc as f32;
    let use_lf = fh.flags & crate::frame_header::FLAG_USE_LF_FRAME != 0;
    let mul_dc = if use_lf || jpeg { [1.0; 3] } else { [inv_quant_dc * lf_dequant[0], inv_quant_dc * lf_dequant[1], inv_quant_dc * lf_dequant[2]] };
    let (xb, yb) = (dims.xsize_blocks, dims.ysize_blocks);
    let n = xb.checked_mul(yb).ok_or(Error::Limit("frame too large"))?;
    let hs = [fh.hshift(0) as usize, fh.hshift(1) as usize, fh.hshift(2) as usize];
    let vs = [fh.vshift(0) as usize, fh.vshift(1) as usize, fh.vshift(2) as usize];
    let ctiles_x = xb.div_ceil(8);
    let ctiles_y = yb.div_ceil(8);
    let mk = |c: usize| Plane::new(xb >> hs[c], yb >> vs[c]);
    let mkp = |c: usize| Plane::new((xb >> hs[c]) * 8, (yb >> vs[c]) * 8);
    Ok(VarDct {
        global_scale,
        inv_global_scale,
        mul_dc,
        block_ctx,
        cfl,
        xb,
        yb,
        dc: [mk(0)?, mk(1)?, mk(2)?],
        quant_dc_ctx: vec![0; n],
        acs: vec![INVALID_ACS; n],
        qf: vec![1; n],
        sharpness: vec![0; n],
        ytox: vec![0; ctiles_x * ctiles_y],
        ytob: vec![0; ctiles_x * ctiles_y],
        ctiles_x,
        used_acs: 0,
        tables: vec![None; quant::NUM_TABLES],
        encodings: Vec::new(),
        num_histograms: 0,
        orders: Vec::new(),
        codes: Vec::new(),
        x_dm: (0.8f64).powf(f64::from(fh.x_qm_scale) - 2.0) as f32,
        b_dm: (0.8f64).powf(f64::from(fh.b_qm_scale) - 2.0) as f32,
        quant_bias,
        planes: [mkp(0)?, mkp(1)?, mkp(2)?],
        hs,
        vs,
        use_lf_frame: use_lf,
        bufs: None,
        jpeg: if jpeg {
            Some(JpegCoeffs { comps: Vec::new(), c_map: [0; 3], gray: false, scaled_qtable: [0; 192], dcoff: [0; 3], qtable: Vec::new() })
        } else {
            None
        },
        ycbcr: fh.ycbcr,
    })
}

fn decode_modular_image(br: &mut BitReader, mf: &ModularFrame, chans: Vec<Channel>, stream_id: usize) -> Result<ModularImage> {
    let mut img = ModularImage::new(mf.image.bit_depth);
    img.channels = chans;
    let opts = StreamOptions { max_chan_size: usize::MAX, group_dim: usize::MAX };
    modular::decode_stream(br, &mut img, stream_id, mf.global_tree(), &opts)?;
    img.undo_transforms()?;
    for c in img.channels.iter_mut() {
        c.alloc()?;
    }
    Ok(img)
}

impl VarDct {
    /// LF coefficients of LF group `g` (I.3.1).
    pub fn read_lf_dc(&mut self, br: &mut BitReader, mf: &ModularFrame, dims: &FrameDims, g: usize) -> Result<()> {
        let gd = dims.group_dim;
        let bx0 = (g % dims.xsize_lf_groups) * gd;
        let by0 = (g / dims.xsize_lf_groups) * gd;
        let bw = gd.min(self.xb - bx0);
        let bh = gd.min(self.yb - by0);
        let extra_precision = br.read(2);
        let mul = 1.0 / (1u32 << extra_precision) as f32;
        let mut chans = Vec::with_capacity(3);
        for m in 0..3 {
            let c = if m < 2 { m ^ 1 } else { m };
            chans.push(Channel::placeholder(bw >> self.hs[c], bh >> self.vs[c], 0, 0));
        }
        let img = decode_modular_image(br, mf, chans, 1 + g)?;
        let ch = |c: usize| &img.channels[if c < 2 { c ^ 1 } else { c }];
        let is444 = self.hs == [0; 3] && self.vs == [0; 3];
        if is444 {
            let fx = self.mul_dc[0] * mul;
            let fy = self.mul_dc[1] * mul;
            let fb = self.mul_dc[2] * mul;
            let cx = self.cfl.ytox(self.cfl.ytox_dc);
            let cb = self.cfl.ytob(self.cfl.ytob_dc);
            let (qx, qy, qb) = (ch(0), ch(1), ch(2));
            for y in 0..bh {
                for x in 0..bw {
                    let i = y * bw + x;
                    let in_x = qx.data[i] as f32 * fx;
                    let in_y = qy.data[i] as f32 * fy;
                    let in_b = qb.data[i] as f32 * fb;
                    let o = (by0 + y) * self.xb + bx0 + x;
                    self.dc[1].data[o] = in_y;
                    self.dc[0].data[o] = in_y * cx + in_x;
                    self.dc[2].data[o] = in_y * cb + in_b;
                }
            }
        } else {
            for c in [1usize, 0, 2] {
                let f = self.mul_dc[c] * mul;
                let q = ch(c);
                let (w, h) = (bw >> self.hs[c], bh >> self.vs[c]);
                let pw = self.dc[c].w;
                let (ox, oy) = (bx0 >> self.hs[c], by0 >> self.vs[c]);
                for y in 0..h {
                    for x in 0..w {
                        self.dc[c].data[(oy + y) * pw + ox + x] = q.data[y * q.w + x] as f32 * f;
                    }
                }
            }
        }
        if self.block_ctx.num_dc_ctxs > 1 {
            let t = &self.block_ctx.dc_thresholds;
            for y in 0..bh {
                for x in 0..bw {
                    let q = |c: usize| {
                        let chn = ch(c);
                        chn.data[(y >> self.vs[c]) * chn.w + (x >> self.hs[c])]
                    };
                    let bucket = |c: usize| t[c].iter().filter(|&&th| q(c) > th).count();
                    let mut b = bucket(0);
                    b = b * (t[2].len() + 1) + bucket(2);
                    b = b * (t[1].len() + 1) + bucket(1);
                    self.quant_dc_ctx[(by0 + y) * self.xb + bx0 + x] = b as u8;
                }
            }
        }
        Ok(())
    }

    /// AC metadata of LF group `g` (I.3.2): transforms, quantisation field, CfL and EPF maps.
    pub fn read_ac_metadata(&mut self, br: &mut BitReader, mf: &ModularFrame, dims: &FrameDims, g: usize, is444: bool) -> Result<()> {
        let gd = dims.group_dim;
        let bx0 = (g % dims.xsize_lf_groups) * gd;
        let by0 = (g / dims.xsize_lf_groups) * gd;
        let bw = gd.min(self.xb - bx0);
        let bh = gd.min(self.yb - by0);
        let upper = bw * bh;
        let count = br.read(ceil_log2(upper as u32)) as usize + 1;
        let (cx0, cy0, cw, chh) = (bx0 >> 3, by0 >> 3, bw.div_ceil(8), bh.div_ceil(8));
        let chans = vec![
            Channel::placeholder(cw, chh, 3, 3),
            Channel::placeholder(cw, chh, 3, 3),
            Channel::placeholder(count, 2, 0, 0),
            Channel::placeholder(bw, bh, 0, 0),
        ];
        let sid = 1 + 2 * dims.num_lf_groups + g;
        let img = decode_modular_image(br, mf, chans, sid)?;
        for y in 0..chh {
            for x in 0..cw {
                let o = (cy0 + y) * self.ctiles_x + cx0 + x;
                self.ytox[o] = img.channels[0].data[y * cw + x].clamp(-128, 127) as i8;
                self.ytob[o] = img.channels[1].data[y * cw + x].clamp(-128, 127) as i8;
            }
        }
        let strat = &img.channels[2].data;
        let sharp = &img.channels[3].data;
        let xlim = self.xb.min(bx0 + bw);
        let ylim = self.yb.min(by0 + bh);
        let mut num = 0usize;
        for iy in 0..bh {
            let y = by0 + iy;
            for ix in 0..bw {
                let x = bx0 + ix;
                let s = sharp[iy * bw + ix];
                if !(0..8).contains(&s) {
                    return invalid("EPF sharpness");
                }
                let bi = y * self.xb + x;
                self.sharpness[bi] = s as u8;
                if self.acs[bi] != INVALID_ACS {
                    continue;
                }
                if num >= count {
                    return invalid("too few AC strategies");
                }
                let raw = strat[num];
                if !(0..i32::from(NUM_STRATEGIES)).contains(&raw) {
                    return invalid("AC strategy");
                }
                let acs = AcStrategy(raw as u8);
                self.used_acs |= 1 << raw;
                if acs.is_multiblock() && !is444 {
                    return invalid("multi-block transform with chroma subsampling");
                }
                let nxa = (x / 32 + 1) * 32;
                let nya = (y / 32 + 1) * 32;
                let nx = x + acs.covered_x();
                let ny = y + acs.covered_y();
                if nx > nxa || nx > xlim || ny > nya || ny > ylim {
                    return invalid("AC strategy crosses a group");
                }
                for jy in 0..acs.covered_y() {
                    for jx in 0..acs.covered_x() {
                        let p = (y + jy) * self.xb + x + jx;
                        if self.acs[p] != INVALID_ACS {
                            return invalid("overlapping AC strategies");
                        }
                        self.acs[p] = (acs.0 << 1) | u8::from(jx == 0 && jy == 0);
                    }
                }
                if std::env::var("JXL_ACS_STATS").is_ok() { eprintln!("ACS {}", raw); }
                self.qf[bi] = 1 + strat[count + num].clamp(0, QUANT_MAX - 1);
                num += 1;
            }
        }
        Ok(())
    }

    /// Adaptive LF smoothing (I.3.3), applied to the whole LF image once it is decoded.
    pub fn smooth_lf(&mut self, lf_dequant: &[f32; 3]) {
        let (w, h) = (self.xb, self.yb);
        if w <= 2 || h <= 2 {
            return;
        }
        #[allow(clippy::excessive_precision)]
        let (w1, w2) = (0.20345139757231578f32, 0.0334829185968739f32);
        let w0 = 1.0 - 4.0 * (w1 + w2);
        let dc_factors = [self.mul_dc[0], self.mul_dc[1], self.mul_dc[2]];
        let _ = lf_dequant;
        let src: Vec<Vec<f32>> = self.dc.iter().map(|p| p.data.clone()).collect();
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let mut gap = 0.5f32;
                let mut mc = [0f32; 3];
                let mut sm = [0f32; 3];
                for c in 0..3 {
                    let s = &src[c];
                    let at = |xx: usize, yy: usize| s[yy * w + xx];
                    let (tl, tc, tr) = (at(x - 1, y - 1), at(x, y - 1), at(x + 1, y - 1));
                    let (ml, m, mr) = (at(x - 1, y), at(x, y), at(x + 1, y));
                    let (bl, bc, br) = (at(x - 1, y + 1), at(x, y + 1), at(x + 1, y + 1));
                    let corner = (tl + tr) + (bl + br);
                    let side = (ml + mr) + (tc + bc);
                    sm[c] = corner * w2 + (side * w1 + m * w0);
                    mc[c] = m;
                    gap = gap.max(((m - sm[c]) / dc_factors[c]).abs());
                }
                let factor = (gap * -4.0 + 3.0).max(0.0);
                for c in 0..3 {
                    self.dc[c].data[y * w + x] = (sm[c] - mc[c]) * factor + mc[c];
                }
            }
        }
    }

    /// HF global section (I.4): dequantisation tables, coefficient orders and histograms.
    pub fn read_hf_global(&mut self, br: &mut BitReader, mf: &ModularFrame, dims: &FrameDims, num_passes: usize) -> Result<()> {
        let all_default = br.bit();
        self.encodings = vec![quant::Encoding::Library; quant::NUM_TABLES];
        if !all_default {
            for t in 0..quant::NUM_TABLES {
                let sid = 1 + 3 * dims.num_lf_groups + t;
                let mut raw = |br: &mut BitReader, w: usize, h: usize| -> Result<Vec<i32>> {
                    let chans = (0..3).map(|_| Channel::placeholder(w, h, 0, 0)).collect();
                    let mut img = ModularImage::new(8);
                    img.channels = chans;
                    let opts = StreamOptions { max_chan_size: usize::MAX, group_dim: usize::MAX };
                    modular::decode_stream(br, &mut img, sid, mf.global_tree(), &opts)?;
                    img.undo_transforms()?;
                    let mut out = Vec::with_capacity(3 * w * h);
                    for c in img.channels.iter_mut() {
                        c.alloc()?;
                        out.extend_from_slice(&c.data);
                    }
                    Ok(out)
                };
                self.encodings[t] = quant::read_encoding(br, t, &mut raw)?;
            }
        }
        if self.jpeg.is_some() {
            self.setup_jpeg(dims)?;
        }
        for s in 0..NUM_STRATEGIES {
            if self.used_acs & (1 << s) != 0 {
                let t = AcStrategy(s).quant_table();
                if self.tables[t].is_none() {
                    self.tables[t] = Some(quant::compute_table(&self.encodings[t], t)?);
                }
            }
        }
        self.num_histograms = 1 + br.read(ceil_log2(dims.num_groups as u32)) as usize;
        let num_ctx = self.num_histograms * self.block_ctx.num_ac_contexts();
        for _ in 0..num_passes {
            let used_orders = br.u32([val(0x5F), val(0x13), val(0), bits(13)]);
            self.orders.push(self.read_orders(br, used_orders)?);
            let code = EntropyCode::read(br, num_ctx)?;
            self.codes.push(code);
        }
        br.check_end()
    }

    fn read_orders(&self, br: &mut BitReader, used_orders: u32) -> Result<Vec<u32>> {
        let total = (COEFF_ORDER_OFFSET[39] as usize) * 64;
        let mut order = vec![0u32; total];
        let code_reader = if used_orders != 0 {
            let code = EntropyCode::read(br, 8)?;
            let r = code.reader(br, 0)?;
            Some((code, r))
        } else {
            None
        };
        let mut code_reader = code_reader;
        let mut acs_mask = 0u32;
        for s in 0..NUM_STRATEGIES {
            if self.used_acs & (1 << s) != 0 {
                acs_mask |= 1 << AcStrategy(s).order();
            }
        }
        let mut computed = 0u32;
        for s in 0..NUM_STRATEGIES {
            let a = AcStrategy(s);
            let ord = a.order();
            if computed & (1 << ord) != 0 {
                continue;
            }
            computed |= 1 << ord;
            let used = acs_mask & (1 << ord) != 0;
            let llf = a.covered_x() * a.covered_y();
            let size = 64 * llf;
            if !used && used_orders & (1 << ord) == 0 {
                continue;
            }
            let natural = a.natural_order();
            for c in 0..3 {
                let off = COEFF_ORDER_OFFSET[3 * ord + c] as usize * 64;
                if used_orders & (1 << ord) == 0 {
                    order[off..off + size].copy_from_slice(&natural);
                } else {
                    let (code, r) = code_reader.as_mut().ok_or(Error::Invalid("coefficient order"))?;
                    let perm = read_permutation_with(br, r, code, size, llf)?;
                    if used {
                        for k in 0..size {
                            order[off + k] = natural[perm[k] as usize];
                        }
                    }
                }
            }
        }
        if let Some((_, r)) = &code_reader {
            if !r.check_final_state() {
                return invalid("coefficient order ANS state");
            }
        }
        let _ = coeff_order_context;
        Ok(order)
    }

    /// HF coefficients of pass group `g` for every pass, dequantised and transformed into
    /// `planes` (I.4.3–I.4.6).
    pub fn decode_group(&mut self, readers: &mut [BitReader], dims: &FrameDims, g: usize, shifts: &[u32]) -> Result<()> {
        let gdb = dims.group_dim / 8;
        let bx0 = (g % dims.xsize_groups) * gdb;
        let by0 = (g / dims.xsize_groups) * gdb;
        let bw = gdb.min(self.xb - bx0);
        let bh = gdb.min(self.yb - by0);
        let num_passes = readers.len();
        let hbits = ceil_log2(self.num_histograms as u32);
        let mut ctx_offset = Vec::with_capacity(num_passes);
        let mut syms: Vec<SymbolReader> = Vec::with_capacity(num_passes);
        for (p, br) in readers.iter_mut().enumerate() {
            let h = if hbits != 0 { br.read(hbits) as usize } else { 0 };
            if h >= self.num_histograms {
                return invalid("histogram selector");
            }
            ctx_offset.push(h * self.block_ctx.num_ac_contexts());
            syms.push(self.codes[p].reader(br, 0)?);
        }
        // Non-zero counts per pass and channel, group-local (subsampled) block coordinates.
        let mut nzeros = vec![vec![0i32; gdb * gdb * 3]; num_passes];
        let (mut coeffs, mut block, mut scratch) = match self.bufs.take() {
            Some(b) => b,
            None => {
                let mut max_size = 64usize;
                for s in 0..NUM_STRATEGIES {
                    if self.used_acs & (1 << s) != 0 {
                        max_size = max_size.max(64 << AcStrategy(s).log2_covered());
                    }
                }
                (vec![0i32; 3 * max_size], vec![0f32; 3 * max_size], vec![0f32; 4 * max_size + 1024])
            }
        };
        let mut pixels = Vec::new();
        for by in 0..bh {
            let mut bx = 0;
            while bx < bw {
                let gx = bx0 + bx;
                let gy = by0 + by;
                let raw = self.acs[gy * self.xb + gx];
                if raw == INVALID_ACS {
                    return invalid("missing AC strategy");
                }
                let acs = AcStrategy(raw >> 1);
                if raw & 1 == 0 {
                    bx += 1;
                    continue;
                }
                let cxb = acs.covered_x();
                let log2c = acs.log2_covered();
                let covered = 1usize << log2c;
                let size = covered * 64;
                coeffs[..3 * size].fill(0);
                let ord = acs.order();
                for c in [1usize, 0, 2] {
                    let sbx = bx >> self.hs[c];
                    let sby = by >> self.vs[c];
                    if sbx << self.hs[c] != bx || sby << self.vs[c] != by {
                        continue;
                    }
                    for p in 0..num_passes {
                        let qf = self.qf[gy * self.xb + bx0 + sbx];
                        let qdc = usize::from(self.quant_dc_ctx[gy * self.xb + gx]);
                        let block_ctx = self.block_ctx.context(qdc, qf as u32, ord, c);
                        let nz = &mut nzeros[p];
                        let base = c * gdb * gdb;
                        let pred = if sbx == 0 {
                            if sby == 0 {
                                32
                            } else {
                                nz[base + (sby - 1) * gdb]
                            }
                        } else if sby == 0 {
                            nz[base + sby * gdb + sbx - 1]
                        } else {
                            (nz[base + (sby - 1) * gdb + sbx] + nz[base + sby * gdb + sbx - 1] + 1) / 2
                        };
                        let code = &self.codes[p];
                        let br = &mut readers[p];
                        let r = &mut syms[p];
                        let nzc = self.block_ctx.non_zero_context(pred as u32, block_ctx) + ctx_offset[p];
                        let mut n = r.read(code, br, nzc) as usize;
                        if n > size - covered {
                            return invalid("too many non-zero coefficients");
                        }
                        let per = ((n + covered - 1) >> log2c) as i32;
                        for yy in 0..acs.covered_y() {
                            for xx in 0..cxb {
                                let (px, py) = (sbx + xx, sby + yy);
                                if px < gdb && py < gdb {
                                    nz[base + py * gdb + px] = per;
                                }
                            }
                        }
                        let histo = ctx_offset[p] + self.block_ctx.zero_density_offset(block_ctx);
                        let off = COEFF_ORDER_OFFSET[3 * ord + c] as usize * 64;
                        let order = &self.orders[p][off..off + size];
                        let qb = &mut coeffs[c * size..(c + 1) * size];
                        let mut prev = usize::from(n <= size / 16);
                        let shift = shifts.get(p).copied().unwrap_or(0);
                        let mut k = covered;
                        while k < size && n != 0 {
                            let ctx = histo + zero_density_context(n, k, covered, log2c, prev);
                            let u = r.read(code, br, ctx);
                            let coeff = unpack_signed(u).wrapping_shl(shift);
                            let pos = order[k] as usize;
                            if let Some(q) = qb.get_mut(pos) {
                                *q = q.wrapping_add(coeff);
                            }
                            prev = usize::from(u != 0);
                            n -= prev;
                            k += 1;
                        }
                        if n != 0 {
                            return invalid("non-zero count left at the end of a block");
                        }
                        if br.overrun() {
                            return invalid("truncated HF coefficients");
                        }
                    }
                }
                if self.jpeg.is_some() {
                    self.jpeg_block(acs, gx, gy, &coeffs)?;
                } else {
                    self.dequant_and_transform(acs, gx, gy, &coeffs, &mut block, &mut scratch, &mut pixels)?;
                }
                bx += cxb;
            }
        }
        self.bufs = Some((coeffs, block, scratch));
        for r in &syms {
            if !r.check_final_state() {
                return invalid("HF ANS final state");
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn dequant_and_transform(
        &mut self,
        acs: AcStrategy,
        gx: usize,
        gy: usize,
        coeffs: &[i32],
        block: &mut [f32],
        scratch: &mut [f32],
        _pixels: &mut [f32],
    ) -> Result<()> {
        let covered = 1usize << acs.log2_covered();
        let size = covered * 64;
        let quant = self.qf[gy * self.xb + gx];
        let s = self.inv_global_scale / quant as f32;
        let sdx = s * self.x_dm;
        let sdy = s;
        let sdb = s * self.b_dm;
        let table = self.tables[acs.quant_table()].as_ref().ok_or(Error::Invalid("quantisation table missing"))?;
        let tsize = table.len() / 3;
        if tsize != size {
            return invalid("quantisation table size");
        }
        let tile = (gy / 8) * self.ctiles_x + gx / 8;
        let x_cc = self.cfl.ytox(i32::from(self.ytox[tile]));
        let b_cc = self.cfl.ytob(i32::from(self.ytob[tile]));
        let bias = self.quant_bias;
        let (bx_, rest) = block.split_at_mut(size);
        let (by_, rest) = rest.split_at_mut(size);
        let bb_ = &mut rest[..size];
        // Four coefficients at a time (`size` is a multiple of 64). libjxl's AdjustQuantBias:
        // |q| < 1.125 becomes ±bias[c] (0 stays 0), larger values q − bias[3]/q.
        let (tx, ty, tb) = (&table[..size], &table[tsize..tsize + size], &table[2 * tsize..2 * tsize + size]);
        let (cx, cy, cb) = (&coeffs[..size], &coeffs[size..2 * size], &coeffs[2 * size..3 * size]);
        let adjust = |c: usize, q: &[i32]| -> F4 {
            let qf = F4::from_i32(q);
            let a = qf.abs();
            let zero = F4::splat(0.0);
            let small = a.gt_select(zero, F4::splat(bias[c]).copysign(qf), zero);
            let big = qf.sub(F4::splat(bias[3]).div(qf));
            F4::splat(1.125).gt_select(a, small, big)
        };
        let (vsdx, vsdy, vsdb, vx_cc, vb_cc) = (F4::splat(sdx), F4::splat(sdy), F4::splat(sdb), F4::splat(x_cc), F4::splat(b_cc));
        for k in (0..size).step_by(4) {
            let x_mul = F4::load(&tx[k..]).mul(vsdx);
            let y_mul = F4::load(&ty[k..]).mul(vsdy);
            let b_mul = F4::load(&tb[k..]).mul(vsdb);
            let dx_cc = adjust(0, &cx[k..]).mul(x_mul);
            let dy = adjust(1, &cy[k..]).mul(y_mul);
            let db_cc = adjust(2, &cb[k..]).mul(b_mul);
            vx_cc.mul(dy).add(dx_cc).store(&mut bx_[k..]);
            dy.store(&mut by_[k..]);
            vb_cc.mul(dy).add(db_cc).store(&mut bb_[k..]);
        }
        let blocks = [bx_, by_, bb_];
        for (c, b) in blocks.into_iter().enumerate() {
            let sbx = gx >> self.hs[c];
            let sby = gy >> self.vs[c];
            if sbx << self.hs[c] != gx || sby << self.vs[c] != gy {
                continue;
            }
            let dcp = &self.dc[c];
            let dc_off = sby * dcp.w + sbx;
            idct::llf_from_dc(acs, &dcp.data[dc_off..], dcp.w, b, scratch);
            let p = &mut self.planes[c];
            let stride = p.w;
            let off = sby * 8 * stride + sbx * 8;
            idct::transform_to_pixels(acs, b, &mut p.data[off..], stride, scratch);
        }
        Ok(())
    }

    /// JPEG reconstruction setup from the frame's RAW quantisation table (libjxl's
    /// ProcessACGlobal and DecodeGroupImpl).
    fn setup_jpeg(&mut self, dims: &FrameDims) -> Result<()> {
        let qt = match &self.encodings[0] {
            quant::Encoding::Raw(den, t) if (den - 1.0 / (8.0 * 255.0)).abs() <= 1e-8 && t.len() == 192 => t.clone(),
            _ => return invalid("quantisation table is not a JPEG table"),
        };
        if self.cfl.base_x != 0.0 || self.cfl.base_b != 0.0 || (self.cfl.color_scale - 1.0 / 84.0).abs() > 0.0 || self.cfl.ytox_dc != 0 || self.cfl.ytob_dc != 0 {
            return invalid("chroma from luma map is not JPEG-compatible");
        }
        let ycbcr = self.ycbcr;
        let (xb, yb) = (dims.xsize_blocks, dims.ysize_blocks);
        let (hs, vs) = (self.hs, self.vs);
        let j = self.jpeg.as_mut().ok_or(Error::Invalid("JPEG state"))?;
        for c in 0..3 {
            if !ycbcr {
                j.dcoff[c] = 1024 / qt[64 * c].max(1);
            }
            for i in 0..64 {
                let num = qt[64 + i];
                let den = qt[64 * c + i];
                if num <= 0 || den <= 0 || num >= 65536 || den >= 65536 {
                    return invalid("JPEG quantisation table");
                }
                j.scaled_qtable[64 * c + (i % 8) * 8 + i / 8] = (1 << 11) * num / den;
            }
        }
        if j.comps.is_empty() {
            let n = if j.gray { 1 } else { 3 };
            for c in 0..n {
                let jc = if j.gray { 1 } else { c };
                let _ = jc;
                j.comps.push((0, 0, Vec::new()));
            }
            for c in 0..3 {
                if j.gray && c != 1 {
                    continue;
                }
                let k = j.c_map[c];
                let w = xb >> hs[c];
                let h = yb >> vs[c];
                let n = w.checked_mul(h).and_then(|v| v.checked_mul(64)).ok_or(Error::Limit("JPEG too large"))?;
                j.comps[k] = (w, h, vec![0i16; n]);
            }
        }
        j.qtable = qt;
        Ok(())
    }

    /// Stores one block's quantised coefficients for JPEG reconstruction.
    fn jpeg_block(&mut self, acs: AcStrategy, gx: usize, gy: usize, coeffs: &[i32]) -> Result<()> {
        if acs.0 != 0 {
            return invalid("JPEG reconstruction needs DCT 8×8 blocks only");
        }
        let is444 = self.hs == [0; 3] && self.vs == [0; 3];
        let tile = (gy / 8) * self.ctiles_x + gx / 8;
        let (ytox, ytob) = (i32::from(self.ytox[tile]), i32::from(self.ytob[tile]));
        let hs = self.hs;
        let vs = self.vs;
        let dcv: [f32; 3] = core::array::from_fn(|c| {
            let p = &self.dc[c];
            p.data.get((gy >> vs[c]) * p.w + (gx >> hs[c])).copied().unwrap_or(0.0)
        });
        let j = self.jpeg.as_mut().ok_or(Error::Invalid("JPEG state"))?;
        let mut y_t = [0i32; 64];
        for c in [1usize, 0, 2] {
            if j.gray && c != 1 {
                continue;
            }
            if (gx >> hs[c]) << hs[c] != gx || (gy >> vs[c]) << vs[c] != gy {
                continue;
            }
            let mut t = [0i32; 64];
            t.copy_from_slice(&coeffs[c * 64..c * 64 + 64]);
            for y in 0..8 {
                for x in y + 1..8 {
                    t.swap(y * 8 + x, x * 8 + y);
                }
            }
            let k = j.c_map[c];
            let (w, _h, ref mut out) = j.comps[k];
            let bi = (gy >> vs[c]) * w + (gx >> hs[c]);
            let pos = out.get_mut(bi * 64..bi * 64 + 64).ok_or(Error::Invalid("JPEG block position"))?;
            let sat = |v: i32| v.clamp(-32768, 32767) as i16;
            if !is444 || (ytox == 0 && ytob == 0) {
                for i in 0..64 {
                    pos[i] = sat(t[i]);
                }
            } else if c == 1 {
                y_t = t;
                for i in 0..64 {
                    pos[i] = sat(t[i]);
                }
            } else {
                let f = if c == 0 { ytox } else { ytob };
                let scale = f * (1 << 11) / 84;
                let round = 1 << 10;
                for i in 0..64 {
                    let qt = j.scaled_qtable[c * 64 + i];
                    let coeff_scale = qt.wrapping_mul(scale).wrapping_add(round) >> 11;
                    let cfl = y_t[i].wrapping_mul(coeff_scale).wrapping_add(round) >> 11;
                    pos[i] = sat(t[i].wrapping_add(cfl));
                }
            }
            pos[0] = (dcv[c] - j.dcoff[c] as f32).clamp(-2047.0, 2047.0) as i16;
            if pos.iter().any(|&v| !(-4095..=4095).contains(&v)) {
                return invalid("JPEG DCT coefficients out of range");
            }
        }
        Ok(())
    }

    /// Sets the LF image from an LF frame (flag FLAG_USE_LF_FRAME).
    pub fn set_lf_from_frame(&mut self, lf: &[Plane]) -> Result<()> {
        for c in 0..3 {
            let src = lf.get(c).ok_or(Error::Invalid("LF frame channels"))?;
            let dst = &mut self.dc[c];
            if src.w < dst.w || src.h < dst.h {
                return invalid("LF frame too small");
            }
            for y in 0..dst.h {
                dst.data[y * dst.w..(y + 1) * dst.w].copy_from_slice(&src.data[y * src.w..y * src.w + dst.w]);
            }
        }
        Ok(())
    }

    /// EPF inverse sigma per block (libjxl's ComputeSigma).
    pub fn epf_inv_sigma(&self, lf: &crate::frame_header::LoopFilter) -> Vec<f32> {
        #[allow(clippy::excessive_precision)]
        const INV_SIGMA_NUM: f32 = -1.1715728752538099024;
        let quant_scale = (f64::from(self.global_scale) * (1.0 / 65536.0)) as f32;
        let mut out = vec![0f32; self.xb * self.yb];
        for by in 0..self.yb {
            for bx in 0..self.xb {
                let raw = self.acs[by * self.xb + bx];
                if raw & 1 == 0 || raw == INVALID_ACS {
                    continue;
                }
                let acs = AcStrategy(raw >> 1);
                let sigma_quant = lf.epf_quant_mul / (quant_scale * self.qf[by * self.xb + bx] as f32 * INV_SIGMA_NUM);
                for iy in 0..acs.covered_y() {
                    for ix in 0..acs.covered_x() {
                        let (x, y) = (bx + ix, by + iy);
                        if x >= self.xb || y >= self.yb {
                            continue;
                        }
                        let s = sigma_quant * lf.epf_sharp_lut[usize::from(self.sharpness[y * self.xb + x] & 7)];
                        let s = s.min(-1e-4);
                        out[y * self.xb + x] = 1.0 / s;
                    }
                }
            }
        }
        out
    }
}
