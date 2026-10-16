//! Decoding one frame's sections (ISO/IEC 18181-1 Annex C, G): LF global, LF groups,
//! HF global and pass groups.

use crate::bits::BitReader;
use crate::error::{invalid, Error, Result};
use crate::frame_header::{Encoding, FrameDims, FrameHeader, Toc, FLAG_NOISE, FLAG_PATCHES, FLAG_SPLINES};
use crate::headers::Headers;
use crate::modular::{self, Channel, ModularImage, StreamOptions, TreeCode};

/// Reader for the frame's sections, in section order.
pub struct Sections<'a> {
    data: &'a [u8],
    toc: &'a Toc,
    shared: Option<BitReader<'a>>,
}

impl<'a> Sections<'a> {
    pub fn new(data: &'a [u8], toc: &'a Toc) -> Result<Self> {
        if toc.total > data.len() {
            return invalid("frame data truncated");
        }
        let shared = if toc.single { Some(BitReader::new(&data[..toc.total])) } else { None };
        Ok(Sections { data, toc, shared })
    }

    /// Runs `f` on the reader for section `idx`; checks the reader stayed in bounds.
    pub fn with<T>(&mut self, idx: usize, f: impl FnOnce(&mut BitReader<'a>) -> Result<T>) -> Result<T> {
        if let Some(br) = self.shared.as_mut() {
            let v = f(br)?;
            br.check_end()?;
            return Ok(v);
        }
        let &(off, size) = self.toc.entries.get(idx).ok_or(Error::Invalid("section index"))?;
        let slice = self.data.get(off..off + size).ok_or(Error::Invalid("section out of range"))?;
        let mut br = BitReader::new(slice);
        let v = f(&mut br)?;
        br.check_end()?;
        Ok(v)
    }
}

pub fn lf_group_index(_dims: &FrameDims, g: usize) -> usize {
    1 + g
}
pub fn hf_global_index(dims: &FrameDims) -> usize {
    1 + dims.num_lf_groups
}
pub fn pass_group_index(dims: &FrameDims, pass: usize, g: usize) -> usize {
    2 + dims.num_lf_groups + pass * dims.num_groups + g
}

/// Rectangle (x0, y0, w, h) of a region scaled down by shifts and clipped to (cw, ch).
fn channel_rect(x0: usize, y0: usize, w: usize, h: usize, hs: i32, vs: i32, cw: usize, ch: usize) -> (usize, usize, usize, usize) {
    let sh = |v: usize, s: i32| if s >= 0 { v.checked_shr(s as u32).unwrap_or(0) } else { v };
    let (x, y) = (sh(x0, hs), sh(y0, vs));
    let (rw, rh) = (sh(w, hs), sh(h, vs));
    let rw = if x <= cw { rw.min(cw - x) } else { 0 };
    let rh = if y <= ch { rh.min(ch - y) } else { 0 };
    (x, y, rw, rh)
}

/// State of the modular part of a frame.
pub struct ModularFrame {
    pub image: ModularImage,
    global: Option<TreeCode>,
    /// First channel that is decoded in groups instead of the global stream.
    begin_group_ch: usize,
    pub dims: FrameDims,
    /// Number of colour channels coded in the modular image (0 for VarDCT, 1 or 3).
    pub nb_color: usize,
}

impl ModularFrame {
    /// The global modular section: optional global tree, then the global stream.
    pub fn read_global(br: &mut BitReader, hd: &Headers, fh: &FrameHeader, dims: &FrameDims) -> Result<Self> {
        let m = &hd.metadata;
        let mut nb_chans = if m.colour.is_gray() && !fh.xyb && !fh.ycbcr { 1 } else { 3 };
        let nb_extra = m.extra_channels.len();
        let global = if br.bit() {
            let limit = (1024 + dims.xsize as u64 * dims.ysize as u64 * (nb_chans + nb_extra) as u64 / 16).min(1 << 22);
            Some(TreeCode::read(br, limit as usize)?)
        } else {
            None
        };
        if fh.encoding != Encoding::Modular {
            nb_chans = 0;
        }
        let mut img = ModularImage::new(m.bit_depth.bits);
        for c in 0..nb_chans {
            let (hs, vs) = if fh.ycbcr { (fh.hshift(c) as i32, fh.vshift(c) as i32) } else { (0, 0) };
            let w = dims.xsize.div_ceil(1 << hs);
            let h = dims.ysize.div_ceil(1 << vs);
            img.channels.push(Channel::placeholder(w, h, hs, vs));
        }
        let up_log = crate::entropy::ceil_log2(fh.upsampling) as i32;
        for &ecu in fh.ec_upsampling.iter() {
            let w = dims.xsize_upsampled.div_ceil(ecu as usize);
            let h = dims.ysize_upsampled.div_ceil(ecu as usize);
            let s = crate::entropy::ceil_log2(ecu) as i32 - up_log;
            img.channels.push(Channel::placeholder(w, h, s, s));
        }
        let opts = StreamOptions { max_chan_size: dims.group_dim, group_dim: dims.group_dim };
        modular::decode_stream(br, &mut img, 0, global.as_ref(), &opts)?;
        let mut begin = img.channels.len();
        for (c, ch) in img.channels.iter().enumerate().skip(img.nb_meta) {
            if ch.w > dims.group_dim || ch.h > dims.group_dim {
                begin = c;
                break;
            }
        }
        Ok(ModularFrame { image: img, global, begin_group_ch: begin, dims: *dims, nb_color: nb_chans })
    }

    /// Decodes the channels of a group stream whose shift lies in [min_shift, max_shift],
    /// within the rectangle (x0, y0, size, size) in frame coordinates.
    pub fn read_group(
        &mut self,
        br: &mut BitReader,
        x0: usize,
        y0: usize,
        size: usize,
        min_shift: i32,
        max_shift: i32,
        stream_id: usize,
    ) -> Result<()> {
        let mut local = ModularImage::new(self.image.bit_depth);
        let mut targets = Vec::new();
        for c in self.begin_group_ch..self.image.channels.len() {
            let fc = &self.image.channels[c];
            let shift = fc.hshift.min(fc.vshift);
            if shift > max_shift || shift < min_shift {
                continue;
            }
            let r = channel_rect(x0, y0, size, size, fc.hshift, fc.vshift, fc.w, fc.h);
            if r.2 == 0 || r.3 == 0 {
                continue;
            }
            local.channels.push(Channel::placeholder(r.2, r.3, fc.hshift, fc.vshift));
            targets.push((c, r));
        }
        if local.channels.is_empty() {
            return Ok(());
        }
        let opts = StreamOptions { max_chan_size: usize::MAX, group_dim: usize::MAX };
        modular::decode_stream(br, &mut local, stream_id, self.global.as_ref(), &opts)?;
        local.undo_transforms()?;
        if local.channels.len() != targets.len() {
            return invalid("group transforms changed the channel count");
        }
        for (lc, (c, (x, y, w, h))) in local.channels.iter().zip(targets) {
            if lc.w != w || lc.h != h {
                return invalid("group transforms changed a channel size");
            }
            let fc = &mut self.image.channels[c];
            fc.alloc()?;
            for row in 0..h {
                let dst = (y + row) * fc.w + x;
                fc.data[dst..dst + w].copy_from_slice(&lc.data[row * w..(row + 1) * w]);
            }
        }
        Ok(())
    }
}

/// LF global fields read before the global modular stream.
pub struct LfGlobal {
    pub lf_dequant: [f32; 3],
}

pub const DEFAULT_LF_DEQUANT: [f32; 3] = [1.0 / 4096.0, 1.0 / 512.0, 1.0 / 256.0];

pub fn read_lf_dequant(br: &mut BitReader) -> Result<[f32; 3]> {
    let mut q = DEFAULT_LF_DEQUANT;
    if !br.bit() {
        for v in q.iter_mut() {
            *v = br.f16()? * (1.0 / 128.0);
            if *v < 1e-8 {
                return invalid("LF dequantisation factor");
            }
        }
    }
    Ok(q)
}

/// Everything decoded from a frame's sections, before rendering.
pub struct DecodedFrame {
    /// The modular image with all transforms undone: colour channels (`nb_color` of them,
    /// modular frames only) then the extra channels.
    pub modular: ModularImage,
    pub nb_color: usize,
    pub lf_dequant: [f32; 3],
    pub patches: Vec<crate::render::Patch>,
}

pub fn decode_frame_sections(
    sections: &mut Sections,
    hd: &Headers,
    fh: &FrameHeader,
    refs: &[Option<crate::render::Reference>; 4],
) -> Result<DecodedFrame> {
    let dims = fh.dims();
    if fh.flags & (FLAG_SPLINES | FLAG_NOISE) != 0 {
        return Err(Error::Unsupported("splines or noise"));
    }
    if fh.encoding == Encoding::VarDct {
        return Err(Error::Unsupported("VarDCT frames"));
    }
    let num_ec = hd.metadata.extra_channels.len();
    let (lf_dequant, patches, mut mf) = sections.with(0, |br| {
        let patches = if fh.flags & FLAG_PATCHES != 0 {
            read_patches(br, dims.xsize_padded, dims.ysize_padded, num_ec, refs)?
        } else {
            Vec::new()
        };
        let q = read_lf_dequant(br)?;
        let mf = ModularFrame::read_global(br, hd, fh, &dims)?;
        Ok((q, patches, mf))
    })?;
    for g in 0..dims.num_lf_groups {
        let gx = g % dims.xsize_lf_groups;
        let gy = g / dims.xsize_lf_groups;
        let d = dims.lf_group_dim;
        let sid = 1 + dims.num_lf_groups + g;
        sections.with(lf_group_index(&dims, g), |br| mf.read_group(br, gx * d, gy * d, d, 3, 1000, sid))?;
    }
    sections.with(hf_global_index(&dims), |_| Ok(()))?;
    for p in 0..fh.passes.num_passes as usize {
        let (min_s, max_s) = fh.passes.downsampling_bracket(p as u32);
        for g in 0..dims.num_groups {
            let gx = g % dims.xsize_groups;
            let gy = g / dims.xsize_groups;
            let d = dims.group_dim;
            let sid = 1 + 3 * dims.num_lf_groups + 17 + dims.num_groups * p + g;
            sections.with(pass_group_index(&dims, p, g), |br| mf.read_group(br, gx * d, gy * d, d, min_s, max_s, sid))?;
        }
    }
    let nb_color = mf.nb_color;
    let mut image = mf.image;
    image.undo_transforms()?;
    if image.channels.len() != nb_color + num_ec {
        return invalid("modular image has the wrong number of channels");
    }
    Ok(DecodedFrame { modular: image, nb_color, lf_dequant, patches })
}

/// Patch dictionary (K.3.1). `xsize`/`ysize` bound the patch positions (the padded frame).
pub fn read_patches(
    br: &mut BitReader,
    xsize: usize,
    ysize: usize,
    num_ec: usize,
    refs: &[Option<crate::render::Reference>; 4],
) -> Result<Vec<crate::render::Patch>> {
    use crate::bits::unpack_signed;
    use crate::render::{Patch, PatchBlending, PatchMode};
    let code = crate::entropy::EntropyCode::read(br, 10)?;
    let mut r = code.reader(br, 0)?;
    let num_ref = r.read(&code, br, 0) as usize;
    let max_ref = 1024 + xsize * ysize / 4;
    let max_patches = max_ref * 4;
    if num_ref > max_ref {
        return invalid("too many patches");
    }
    let mut out: Vec<Patch> = Vec::new();
    for _ in 0..num_ref {
        let reference = r.read(&code, br, 1) as usize;
        let rf = refs.get(reference).and_then(|r| r.as_ref()).ok_or(Error::Invalid("patch reference frame"))?;
        if rf.image.width() == 0 {
            return invalid("patch reference frame");
        }
        if !rf.before_ct {
            return invalid("patches cannot use frames saved after the colour transform");
        }
        let rx0 = r.read(&code, br, 3) as usize;
        let ry0 = r.read(&code, br, 3) as usize;
        let w = r.read(&code, br, 2) as usize + 1;
        let h = r.read(&code, br, 2) as usize + 1;
        if rx0 + w > rf.image.width() || ry0 + h > rf.image.height() {
            return invalid("patch outside its reference frame");
        }
        let count = r.read(&code, br, 7) as usize;
        if count >= max_patches || out.len() + count + 1 > max_patches {
            return invalid("too many patches");
        }
        let (mut px, mut py) = (0usize, 0usize);
        for i in 0..=count {
            if i == 0 {
                px = r.read(&code, br, 4) as usize;
                py = r.read(&code, br, 4) as usize;
            } else {
                let dx = unpack_signed(r.read(&code, br, 6)) as i64;
                let dy = unpack_signed(r.read(&code, br, 6)) as i64;
                let nx = px as i64 + dx;
                let ny = py as i64 + dy;
                if nx < 0 || ny < 0 {
                    return invalid("patch position");
                }
                px = nx as usize;
                py = ny as usize;
            }
            if px + w > xsize || py + h > ysize {
                return invalid("patch outside the frame");
            }
            let mut blending = Vec::with_capacity(num_ec + 1);
            for _ in 0..=num_ec {
                let mode = match r.read(&code, br, 5) {
                    0 => PatchMode::None,
                    1 => PatchMode::Replace,
                    2 => PatchMode::Add,
                    3 => PatchMode::Mul,
                    4 => PatchMode::BlendAbove,
                    5 => PatchMode::BlendBelow,
                    6 => PatchMode::AwAddAbove,
                    7 => PatchMode::AwAddBelow,
                    _ => return invalid("patch blend mode"),
                };
                let uses_alpha = matches!(mode, PatchMode::BlendAbove | PatchMode::BlendBelow | PatchMode::AwAddAbove | PatchMode::AwAddBelow);
                let mut alpha_channel = 0;
                if uses_alpha && num_ec > 1 {
                    alpha_channel = r.read(&code, br, 8) as usize;
                    if alpha_channel >= num_ec {
                        return invalid("patch alpha channel");
                    }
                }
                let clamp = if uses_alpha || mode == PatchMode::Mul { r.read(&code, br, 9) != 0 } else { false };
                blending.push(PatchBlending { mode, alpha_channel, clamp });
            }
            out.push(Patch { reference, rx0, ry0, w, h, x: px, y: py, blending });
            if br.overrun() {
                return invalid("truncated patches");
            }
        }
    }
    if !r.check_final_state() {
        return invalid("patches ANS state");
    }
    Ok(out)
}
