//! Frame headers and the table of contents (ISO/IEC 18181-1 Annex C.2, C.3).

use crate::bits::{bits, bits_offset, unpack_signed, val, BitReader};
use crate::entropy::{ceil_log2, EntropyCode};
use crate::error::{invalid, Error, Result};
use crate::headers::Headers;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameType {
    Regular,
    Lf,
    ReferenceOnly,
    SkipProgressive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    VarDct,
    Modular,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlendMode {
    Replace,
    Add,
    Blend,
    AlphaWeightedAdd,
    Mul,
}

#[derive(Clone, Copy, Debug)]
pub struct BlendingInfo {
    pub mode: BlendMode,
    pub alpha_channel: u32,
    pub clamp: bool,
    pub source: u32,
}

impl Default for BlendingInfo {
    fn default() -> Self {
        BlendingInfo { mode: BlendMode::Replace, alpha_channel: 0, clamp: false, source: 0 }
    }
}

fn read_blending(br: &mut BitReader, num_ec: usize, partial: bool) -> Result<BlendingInfo> {
    let mode = match br.u32([val(0), val(1), val(2), bits_offset(2, 3)]) {
        0 => BlendMode::Replace,
        1 => BlendMode::Add,
        2 => BlendMode::Blend,
        3 => BlendMode::AlphaWeightedAdd,
        4 => BlendMode::Mul,
        _ => return invalid("blend mode"),
    };
    let mut b = BlendingInfo { mode, ..BlendingInfo::default() };
    let uses_alpha = matches!(b.mode, BlendMode::Blend | BlendMode::AlphaWeightedAdd);
    if num_ec > 0 && uses_alpha {
        b.alpha_channel = br.u32([val(0), val(1), val(2), bits_offset(3, 3)]);
        if b.alpha_channel as usize >= num_ec {
            return invalid("blending alpha channel");
        }
    }
    if (num_ec > 0 && uses_alpha) || b.mode == BlendMode::Mul {
        b.clamp = br.bit();
    }
    if b.mode != BlendMode::Replace || partial {
        b.source = br.u32([val(0), val(1), val(2), val(3)]);
    }
    Ok(b)
}

#[derive(Clone, Debug)]
pub struct Passes {
    pub num_passes: u32,
    pub num_ds: u32,
    pub shift: [u32; 11],
    pub downsample: [u32; 4],
    pub last_pass: [u32; 4],
}

impl Default for Passes {
    fn default() -> Self {
        Passes { num_passes: 1, num_ds: 0, shift: [0; 11], downsample: [1; 4], last_pass: [0; 4] }
    }
}

impl Passes {
    fn read(br: &mut BitReader) -> Result<Self> {
        let mut p = Passes { num_passes: br.u32([val(1), val(2), val(3), bits_offset(3, 4)]), ..Passes::default() };
        if p.num_passes > 11 {
            return invalid("too many passes");
        }
        if p.num_passes != 1 {
            p.num_ds = br.u32([val(0), val(1), val(2), bits_offset(1, 3)]);
            if p.num_ds > p.num_passes || p.num_ds > 4 {
                return invalid("num_downsample");
            }
            for i in 0..(p.num_passes - 1) as usize {
                p.shift[i] = br.read(2);
            }
            for i in 0..p.num_ds as usize {
                p.downsample[i] = br.u32([val(1), val(2), val(4), val(8)]);
                if i > 0 && p.downsample[i] >= p.downsample[i - 1] {
                    return invalid("downsample sequence");
                }
            }
            for i in 0..p.num_ds as usize {
                p.last_pass[i] = br.u32([val(0), val(1), val(2), bits(3)]);
                if i > 0 && p.last_pass[i] <= p.last_pass[i - 1] {
                    return invalid("last_pass sequence");
                }
                if p.last_pass[i] >= p.num_passes {
                    return invalid("last_pass");
                }
            }
        }
        Ok(p)
    }

    /// (min_shift, max_shift) of the modular channels coded in pass `pass`.
    pub fn downsampling_bracket(&self, pass: u32) -> (i32, i32) {
        let mut max_shift = 2;
        let mut min_shift = 3;
        let mut i = 0;
        loop {
            for j in 0..self.num_ds as usize {
                if i == self.last_pass[j] {
                    min_shift = match self.downsample[j] {
                        8 => 3,
                        4 => 2,
                        2 => 1,
                        _ => 0,
                    };
                }
            }
            if i == self.num_passes - 1 {
                min_shift = 0;
            }
            if i == pass {
                return (min_shift, max_shift);
            }
            max_shift = min_shift - 1;
            i += 1;
        }
    }
}

#[derive(Clone, Debug)]
pub struct LoopFilter {
    pub gab: bool,
    pub gab_weights: [f32; 6],
    pub epf_iters: u32,
    pub epf_sharp_lut: [f32; 8],
    pub epf_channel_scale: [f32; 3],
    pub epf_pass1_zeroflush: f32,
    pub epf_pass2_zeroflush: f32,
    pub epf_quant_mul: f32,
    pub epf_pass0_sigma_scale: f32,
    pub epf_pass2_sigma_scale: f32,
    pub epf_border_sad_mul: f32,
    pub epf_sigma_for_modular: f32,
}

impl Default for LoopFilter {
    fn default() -> Self {
        let w1 = (1.1 * 0.104_699_568f64) as f32;
        let w2 = (1.1 * 0.055_680_538f64) as f32;
        LoopFilter {
            gab: true,
            gab_weights: [w1, w2, w1, w2, w1, w2],
            epf_iters: 2,
            epf_sharp_lut: core::array::from_fn(|i| i as f32 / 7.0),
            epf_channel_scale: [40.0, 5.0, 3.5],
            epf_pass1_zeroflush: 0.45,
            epf_pass2_zeroflush: 0.6,
            epf_quant_mul: 0.46,
            epf_pass0_sigma_scale: 0.9,
            epf_pass2_sigma_scale: 6.5,
            epf_border_sad_mul: 2.0 / 3.0,
            epf_sigma_for_modular: 1.0,
        }
    }
}

fn read_loop_filter(br: &mut BitReader, modular: bool) -> Result<LoopFilter> {
    let mut lf = LoopFilter::default();
    if br.bit() {
        return Ok(lf);
    }
    lf.gab = br.bit();
    if lf.gab && br.bit() {
        for i in 0..3 {
            let a = br.f16()?;
            let b = br.f16()?;
            if (1.0 + (a + b) * 4.0).abs() < 1e-8 {
                return invalid("gaborish weights");
            }
            lf.gab_weights[2 * i] = a;
            lf.gab_weights[2 * i + 1] = b;
        }
    }
    lf.epf_iters = br.read(2);
    if lf.epf_iters > 0 {
        if !modular && br.bit() {
            for v in lf.epf_sharp_lut.iter_mut() {
                *v = br.f16()?;
            }
        }
        if br.bit() {
            for v in lf.epf_channel_scale.iter_mut() {
                *v = br.f16()?;
            }
            lf.epf_pass1_zeroflush = br.f16()?;
            lf.epf_pass2_zeroflush = br.f16()?;
        }
        if br.bit() {
            if !modular {
                lf.epf_quant_mul = br.f16()?;
            }
            lf.epf_pass0_sigma_scale = br.f16()?;
            lf.epf_pass2_sigma_scale = br.f16()?;
            lf.epf_border_sad_mul = br.f16()?;
        }
        if modular {
            lf.epf_sigma_for_modular = br.f16()?;
            if lf.epf_sigma_for_modular < 1e-8 {
                return invalid("EPF sigma for modular");
            }
        }
    }
    br.extensions()?;
    Ok(lf)
}

pub const FLAG_NOISE: u64 = 1;
pub const FLAG_PATCHES: u64 = 2;
pub const FLAG_SPLINES: u64 = 16;
pub const FLAG_USE_LF_FRAME: u64 = 32;
pub const FLAG_SKIP_ADAPTIVE_LF_SMOOTHING: u64 = 128;

#[derive(Clone, Debug)]
pub struct FrameHeader {
    pub frame_type: FrameType,
    pub encoding: Encoding,
    pub flags: u64,
    pub xyb: bool,
    pub ycbcr: bool,
    /// Chroma channel modes, in the frame's channel order (Cb, Y, Cr for YCbCr).
    pub chroma_mode: [u32; 3],
    pub upsampling: u32,
    pub ec_upsampling: Vec<u32>,
    pub group_size_shift: u32,
    pub x_qm_scale: u32,
    pub b_qm_scale: u32,
    pub passes: Passes,
    pub lf_level: u32,
    pub x0: i32,
    pub y0: i32,
    /// Frame size before upsampling is undone (the "upsampled" size).
    pub width: u32,
    pub height: u32,
    pub blending: BlendingInfo,
    pub ec_blending: Vec<BlendingInfo>,
    pub duration: u32,
    pub is_last: bool,
    pub save_as_reference: u32,
    pub save_before_ct: bool,
    pub loop_filter: LoopFilter,
}

const H_SHIFT: [u32; 4] = [0, 1, 1, 0];
const V_SHIFT: [u32; 4] = [0, 1, 0, 1];

impl FrameHeader {
    pub fn max_hshift(&self) -> u32 {
        self.chroma_mode.iter().map(|&m| H_SHIFT[m as usize]).max().unwrap_or(0)
    }
    pub fn max_vshift(&self) -> u32 {
        self.chroma_mode.iter().map(|&m| V_SHIFT[m as usize]).max().unwrap_or(0)
    }
    pub fn hshift(&self, c: usize) -> u32 {
        self.max_hshift() - H_SHIFT[self.chroma_mode[c] as usize]
    }
    pub fn vshift(&self, c: usize) -> u32 {
        self.max_vshift() - V_SHIFT[self.chroma_mode[c] as usize]
    }
    pub fn raw_hshift(&self, c: usize) -> u32 {
        H_SHIFT[self.chroma_mode[c] as usize]
    }
    pub fn raw_vshift(&self, c: usize) -> u32 {
        V_SHIFT[self.chroma_mode[c] as usize]
    }
    pub fn is_444(&self) -> bool {
        (0..3).all(|c| self.hshift(c) == 0 && self.vshift(c) == 0)
    }
    pub fn can_be_referenced(&self) -> bool {
        !self.is_last && self.frame_type != FrameType::Lf && (self.duration == 0 || self.save_as_reference != 0)
    }
    pub fn is_visible(&self) -> bool {
        matches!(self.frame_type, FrameType::Regular | FrameType::SkipProgressive) && (self.is_last || self.duration > 0)
    }

    pub fn read(br: &mut BitReader, hd: &Headers, preview: bool) -> Result<Self> {
        let m = &hd.metadata;
        let num_ec = m.extra_channels.len();
        let (dw, dh) = match (preview, m.preview) {
            (true, Some(p)) => (p.width, p.height),
            _ => (hd.size.width, hd.size.height),
        };
        let mut f = FrameHeader {
            frame_type: FrameType::Regular,
            encoding: Encoding::VarDct,
            flags: 0,
            xyb: m.xyb_encoded,
            ycbcr: false,
            chroma_mode: [0; 3],
            upsampling: 1,
            ec_upsampling: vec![1; num_ec],
            group_size_shift: 1,
            x_qm_scale: if m.xyb_encoded { 3 } else { 2 },
            b_qm_scale: 2,
            passes: Passes::default(),
            lf_level: 0,
            x0: 0,
            y0: 0,
            width: dw,
            height: dh,
            blending: BlendingInfo::default(),
            ec_blending: vec![BlendingInfo::default(); num_ec],
            duration: 0,
            is_last: true,
            save_as_reference: 0,
            save_before_ct: false,
            loop_filter: LoopFilter::default(),
        };
        if br.bit() {
            br.check_end()?;
            return Ok(f);
        }
        f.frame_type = match br.u32([val(0), val(1), val(2), val(3)]) {
            0 => FrameType::Regular,
            1 => FrameType::Lf,
            2 => FrameType::ReferenceOnly,
            _ => FrameType::SkipProgressive,
        };
        if preview && f.frame_type != FrameType::Regular {
            return invalid("preview must be a regular frame");
        }
        f.encoding = if br.bit() { Encoding::Modular } else { Encoding::VarDct };
        f.flags = br.u64();
        if !m.xyb_encoded {
            f.ycbcr = br.bit();
        }
        if f.ycbcr && f.flags & FLAG_USE_LF_FRAME == 0 {
            for c in f.chroma_mode.iter_mut() {
                *c = br.read(2);
            }
        }
        if f.flags & FLAG_USE_LF_FRAME == 0 {
            f.upsampling = br.u32([val(1), val(2), val(4), val(8)]);
            for (i, ec) in m.extra_channels.iter().enumerate() {
                let u = br.u32([val(1), val(2), val(4), val(8)]) << ec.dim_shift;
                if u < f.upsampling {
                    return invalid("extra channel upsampling below colour upsampling");
                }
                if u > 8 {
                    return invalid("extra channel upsampling too large");
                }
                f.ec_upsampling[i] = u;
            }
        }
        if f.encoding == Encoding::Modular {
            f.group_size_shift = br.read(2);
        }
        if f.encoding == Encoding::VarDct && f.xyb {
            f.x_qm_scale = br.read(3);
            f.b_qm_scale = br.read(3);
        } else {
            f.x_qm_scale = 2;
            f.b_qm_scale = 2;
        }
        if f.frame_type != FrameType::ReferenceOnly {
            f.passes = Passes::read(br)?;
        }
        if f.frame_type == FrameType::Lf {
            f.lf_level = br.u32([val(1), val(2), val(3), val(4)]);
        }
        let mut partial = false;
        let mut custom_size = false;
        if f.frame_type != FrameType::Lf && br.bit() {
            custom_size = true;
            let d = [bits(8), bits_offset(11, 256), bits_offset(14, 2304), bits_offset(30, 18688)];
            if matches!(f.frame_type, FrameType::Regular | FrameType::SkipProgressive) {
                f.x0 = unpack_signed(br.u32(d));
                f.y0 = unpack_signed(br.u32(d));
            }
            f.width = br.u32(d);
            f.height = br.u32(d);
            if f.width == 0 || f.height == 0 {
                return invalid("zero frame size");
            }
            if matches!(f.frame_type, FrameType::Regular | FrameType::SkipProgressive) {
                partial = f.x0 > 0
                    || f.y0 > 0
                    || (i64::from(f.width) + i64::from(f.x0)) < i64::from(dw)
                    || (i64::from(f.height) + i64::from(f.y0)) < i64::from(dh);
            }
        }
        if matches!(f.frame_type, FrameType::Regular | FrameType::SkipProgressive) {
            f.blending = read_blending(br, num_ec, partial)?;
            let mut replace_all = f.blending.mode == BlendMode::Replace;
            for b in f.ec_blending.iter_mut() {
                *b = read_blending(br, num_ec, partial)?;
                replace_all &= b.mode == BlendMode::Replace;
            }
            if preview && (!replace_all || custom_size) {
                return invalid("preview with blending");
            }
            if let Some(a) = m.animation {
                f.duration = br.u32([val(0), val(1), bits(8), bits(32)]);
                if a.have_timecodes {
                    br.read(32);
                }
            }
            f.is_last = br.bit();
        } else {
            f.is_last = false;
        }
        if f.frame_type != FrameType::Lf && !f.is_last {
            f.save_as_reference = br.u32([val(0), val(1), val(2), val(3)]);
        }
        if f.frame_type != FrameType::Lf {
            if f.can_be_referenced()
                && f.blending.mode == BlendMode::Replace
                && !partial
                && matches!(f.frame_type, FrameType::Regular | FrameType::SkipProgressive)
            {
                f.save_before_ct = br.bit();
            } else if f.frame_type == FrameType::ReferenceOnly {
                f.save_before_ct = br.bit();
                if !f.save_before_ct
                    && (f.width < hd.size.width || f.height < hd.size.height || f.x0 != 0 || f.y0 != 0)
                {
                    return invalid("reference frame with invalid crop");
                }
            }
        } else {
            f.save_before_ct = true;
        }
        let name_len = br.u32([val(0), bits(4), bits_offset(5, 16), bits_offset(10, 48)]);
        for _ in 0..name_len {
            br.read(8);
        }
        f.loop_filter = read_loop_filter(br, f.encoding == Encoding::Modular)?;
        br.extensions()?;
        br.check_end()?;
        if !f.is_444() && f.flags & FLAG_SKIP_ADAPTIVE_LF_SMOOTHING == 0 && f.encoding == Encoding::VarDct {
            return invalid("chroma subsampling with adaptive LF smoothing");
        }
        Ok(f)
    }

    pub fn dims(&self) -> FrameDims {
        let mut xs = self.width as usize;
        let mut ys = self.height as usize;
        if self.lf_level != 0 {
            let d = 1usize << (3 * self.lf_level);
            xs = xs.div_ceil(d);
            ys = ys.div_ceil(d);
        }
        FrameDims::new(
            xs,
            ys,
            self.group_size_shift,
            self.max_hshift(),
            self.max_vshift(),
            self.encoding == Encoding::Modular,
            self.upsampling as usize,
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FrameDims {
    pub xsize_upsampled: usize,
    pub ysize_upsampled: usize,
    pub xsize: usize,
    pub ysize: usize,
    pub xsize_blocks: usize,
    pub ysize_blocks: usize,
    pub xsize_padded: usize,
    pub ysize_padded: usize,
    pub group_dim: usize,
    pub lf_group_dim: usize,
    pub xsize_groups: usize,
    pub xsize_lf_groups: usize,
    pub num_groups: usize,
    pub num_lf_groups: usize,
}

impl FrameDims {
    fn new(xs: usize, ys: usize, gss: u32, mhs: u32, mvs: u32, modular: bool, upsampling: usize) -> Self {
        let group_dim = 128usize << gss;
        let xsize = xs.div_ceil(upsampling);
        let ysize = ys.div_ceil(upsampling);
        let xsize_blocks = xsize.div_ceil(8 << mhs) << mhs;
        let ysize_blocks = ysize.div_ceil(8 << mvs) << mvs;
        let (xp, yp) = if modular { (xsize, ysize) } else { (xsize_blocks * 8, ysize_blocks * 8) };
        let xsize_groups = xsize.div_ceil(group_dim);
        let ysize_groups = ysize.div_ceil(group_dim);
        let xsize_lf_groups = xsize_blocks.div_ceil(group_dim);
        let ysize_lf_groups = ysize_blocks.div_ceil(group_dim);
        FrameDims {
            xsize_upsampled: xs,
            ysize_upsampled: ys,
            xsize,
            ysize,
            xsize_blocks,
            ysize_blocks,
            xsize_padded: xp,
            ysize_padded: yp,
            group_dim,
            lf_group_dim: group_dim * 8,
            xsize_groups,
            xsize_lf_groups,
            num_groups: xsize_groups * ysize_groups,
            num_lf_groups: xsize_lf_groups * ysize_lf_groups,
        }
    }
}

/// Section byte ranges of a frame, in section order (LF global, LF groups, HF global, then
/// pass groups pass by pass), relative to the end of the TOC. A single-entry TOC means every
/// section is in the one range, read back to back.
pub struct Toc {
    pub entries: Vec<(usize, usize)>,
    pub single: bool,
    pub total: usize,
}

pub fn read_toc(br: &mut BitReader, dims: &FrameDims, num_passes: usize) -> Result<Toc> {
    let single = dims.num_groups == 1 && num_passes == 1;
    let n = if single { 1 } else { 2 + dims.num_lf_groups + dims.num_groups * num_passes };
    if n > 65536 * 4 {
        return invalid("too many TOC entries");
    }
    // Each entry needs at least 12 bits.
    if (n as u64) * 12 > br.total_bits().saturating_sub(br.bits_consumed()) + 64 {
        return invalid("TOC larger than the data");
    }
    let mut perm = None;
    if br.bit() {
        perm = Some(read_permutation(br, n, 0)?);
    }
    br.jump_to_byte_boundary()?;
    let mut sizes = Vec::with_capacity(n);
    for _ in 0..n {
        sizes.push(br.u32([bits(10), bits_offset(14, 1024), bits_offset(22, 17408), bits_offset(30, 4211712)]) as usize);
    }
    br.jump_to_byte_boundary()?;
    br.check_end()?;
    let mut offsets = Vec::with_capacity(n);
    let mut off = 0usize;
    for &s in &sizes {
        offsets.push(off);
        off = off.checked_add(s).ok_or(Error::Invalid("TOC overflow"))?;
    }
    let mut entries: Vec<(usize, usize)> = offsets.iter().zip(sizes.iter()).map(|(&o, &s)| (o, s)).collect();
    if let Some(p) = perm {
        entries = p.iter().map(|&i| entries[i as usize]).collect();
    }
    Ok(Toc { entries, single, total: off })
}

/// Lehmer-coded permutation (C.3.2), `size` elements, first `skip` fixed.
pub fn read_permutation(br: &mut BitReader, size: usize, skip: usize) -> Result<Vec<u32>> {
    let code = EntropyCode::read(br, 8)?;
    let mut r = code.reader(br, 0)?;
    let p = read_permutation_with(br, &mut r, &code, size, skip)?;
    if !r.check_final_state() {
        return invalid("permutation ANS state");
    }
    Ok(p)
}

pub fn coeff_order_context(v: u32) -> usize {
    // HybridUint(0, 0, 0) token of v, capped at 7.
    let t = if v == 0 { 0 } else { 32 - v.leading_zeros() };
    (t as usize).min(7)
}

pub fn read_permutation_with(
    br: &mut BitReader,
    r: &mut crate::entropy::SymbolReader,
    code: &EntropyCode,
    size: usize,
    skip: usize,
) -> Result<Vec<u32>> {
    let end = r.read(code, br, coeff_order_context(size as u32)) as usize + skip;
    if end > size {
        return invalid("permutation size");
    }
    let mut lehmer = vec![0u32; size];
    let mut last = 0u32;
    for (i, l) in lehmer.iter_mut().enumerate().take(end).skip(skip) {
        *l = r.read(code, br, coeff_order_context(last));
        last = *l;
        if *l as usize >= size - i {
            return invalid("Lehmer code");
        }
        if br.overrun() {
            return invalid("truncated permutation");
        }
    }
    decode_lehmer(&lehmer)
}

fn decode_lehmer(code: &[u32]) -> Result<Vec<u32>> {
    let n = code.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    let log2n = ceil_log2(n as u32);
    let padded = 1usize << log2n;
    let mut temp: Vec<u32> = (0..padded).map(|i| ((i + 1) & (!i)) as u32).collect();
    let mut perm = Vec::with_capacity(n);
    for (i, &c) in code.iter().enumerate() {
        if c as usize + i >= n {
            return invalid("Lehmer code");
        }
        let mut rank = c + 1;
        let mut bit = padded;
        let mut next = 0usize;
        for _ in 0..=log2n {
            let cand = next + bit;
            bit >>= 1;
            if cand >= 1 && cand <= padded && temp[cand - 1] < rank {
                next = cand;
                rank -= temp[cand - 1];
            }
        }
        perm.push(next as u32);
        let mut k = next + 1;
        while k <= padded {
            temp[k - 1] = temp[k - 1].wrapping_sub(1);
            k += k & k.wrapping_neg();
        }
    }
    Ok(perm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lehmer_identity_and_reverse() {
        assert_eq!(decode_lehmer(&[0, 0, 0, 0]).unwrap(), vec![0, 1, 2, 3]);
        assert_eq!(decode_lehmer(&[3, 2, 1, 0]).unwrap(), vec![3, 2, 1, 0]);
        assert_eq!(decode_lehmer(&[1, 0, 0]).unwrap(), vec![1, 0, 2]);
        assert_eq!(decode_lehmer(&[2, 0, 0, 0, 0]).unwrap(), vec![2, 0, 1, 3, 4]);
    }

    #[test]
    fn brackets() {
        let p = Passes::default();
        assert_eq!(p.downsampling_bracket(0), (0, 2));
    }
}
