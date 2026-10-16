//! The frame loop: decodes frames in order, renders them and composites displayed frames.

use crate::bits::BitReader;
use crate::error::{invalid, Error, Result};
use crate::frame::{decode_frame_sections, DecodedFrame, Sections};
use crate::frame_header::{read_toc, BlendMode, Encoding, FrameHeader, FrameType};
use crate::headers::{read_headers, Headers};
use crate::modular::Channel;
use crate::render::{apply_patches, blend_rect, FrameImage, PatchBlending, Plane, Reference};

/// A rendered frame, before conversion to the caller's sample format.
pub enum Rendered {
    /// Exact integers: the modular image's colour channels then extra channels, frame-sized.
    Int(Vec<Channel>, usize),
    /// Canvas planes: 3 colour planes then extra channels (nominal 0..1).
    Float(FrameImage),
}

pub struct Decoder<'a> {
    pub hd: Headers,
    cs: &'a [u8],
    pos: usize,
    refs: [Option<Reference>; 4],
    lf_frames: [Option<Vec<Plane>>; 4],
    done: bool,
    visible_index: u32,
    nonvisible_index: u32,
    /// Allow the exact integer output for a lone lossless frame.
    pub allow_int: bool,
    /// Largest frame (width × height × channels) accepted.
    pub max_samples: u64,
}

impl<'a> Decoder<'a> {
    pub fn new(cs: &'a [u8]) -> Result<Self> {
        let mut br = BitReader::new(cs);
        let hd = read_headers(&mut br)?;
        let mut d = Decoder { hd, cs, pos: br.byte_pos(), refs: [None, None, None, None], lf_frames: [None, None, None, None], done: false, visible_index: 0, nonvisible_index: 0, allow_int: true, max_samples: 1 << 30 };
        if d.hd.metadata.preview.is_some() {
            d.pos = d.skip_frame(true)?;
        }
        Ok(d)
    }

    fn skip_frame(&self, preview: bool) -> Result<usize> {
        let mut br = BitReader::new(self.cs.get(self.pos..).ok_or(Error::Invalid("frame offset"))?);
        let fh = FrameHeader::read(&mut br, &self.hd, preview)?;
        let toc = read_toc(&mut br, &fh.dims(), fh.passes.num_passes as usize)?;
        let end = self.pos + br.byte_pos() + toc.total;
        if end > self.cs.len() {
            return invalid("frame data truncated");
        }
        Ok(end)
    }

    /// Decodes frames up to and including the next displayed one; None after the last.
    pub fn next_displayed(&mut self) -> Result<Option<(FrameHeader, Rendered)>> {
        let mut first = true;
        while !self.done {
            let mut br = BitReader::new(self.cs.get(self.pos..).ok_or(Error::Invalid("frame offset"))?);
            let fh = FrameHeader::read(&mut br, &self.hd, false)?;
            let nch = 3 + self.hd.metadata.extra_channels.len() as u64;
            if u64::from(fh.width).saturating_mul(u64::from(fh.height)).saturating_mul(nch) > self.max_samples {
                return Err(Error::Limit("frame too large"));
            }
            let dims = fh.dims();
            let toc = read_toc(&mut br, &dims, fh.passes.num_passes as usize)?;
            let start = self.pos + br.byte_pos();
            let data = self.cs.get(start..).ok_or(Error::Invalid("frame data"))?;
            let mut sections = Sections::new(data, &toc)?;
            self.pos = start + toc.total;
            if fh.is_last {
                self.done = true;
            }
            if fh.is_visible() {
                self.visible_index += 1;
                self.nonvisible_index = 0;
            } else {
                self.nonvisible_index += 1;
            }
            let df = decode_frame_sections(&mut sections, &self.hd, &fh, &self.refs, &self.lf_frames, None)?;
            if self.allow_int && first && self.int_eligible(&fh, &df) {
                self.done = true;
                let nb = df.nb_color;
                return Ok(Some((fh, Rendered::Int(df.modular.channels, nb))));
            }
            first = false;
            let out = self.render(&fh, df)?;
            if let Some(canvas) = out {
                return Ok(Some((fh, Rendered::Float(canvas))));
            }
        }
        Ok(None)
    }

    fn int_eligible(&self, fh: &FrameHeader, df: &DecodedFrame) -> bool {
        let m = &self.hd.metadata;
        fh.frame_type == FrameType::Regular
            && fh.is_visible()
            && fh.encoding == Encoding::Modular
            && !fh.xyb
            && !fh.ycbcr
            && !m.bit_depth.float
            && m.extra_channels.iter().all(|e| !e.bit_depth.float)
            && fh.upsampling == 1
            && fh.ec_upsampling.iter().all(|&u| u == 1)
            && fh.blending.mode == BlendMode::Replace
            && fh.ec_blending.iter().all(|b| b.mode == BlendMode::Replace)
            && fh.x0 == 0
            && fh.y0 == 0
            && fh.width == self.hd.size.width
            && fh.height == self.hd.size.height
            && !fh.loop_filter.gab
            && fh.loop_filter.epf_iters == 0
            && df.patches.is_empty()
            && df.splines.is_none()
            && df.noise.is_none()
            && df.nb_color > 0
    }

    /// Renders a decoded frame; returns the canvas when the frame is displayed.
    fn render(&mut self, fh: &FrameHeader, df: DecodedFrame) -> Result<Option<FrameImage>> {
        use crate::stages;
        let m = &self.hd.metadata;
        let dims = fh.dims();
        let mut df = df;
        let mut img = to_planes(&self.hd, fh, &mut df)?;
        // Chroma upsampling.
        if fh.ycbcr && !fh.is_444() {
            for c in 0..3 {
                let hs = fh.hshift(c);
                let vs = fh.vshift(c);
                if hs != 0 {
                    img.planes[c] = stages::chroma_upsample_h(&img.planes[c], dims.xsize.div_ceil(1 << (hs - 1)))?;
                }
                if vs != 0 {
                    img.planes[c] = stages::chroma_upsample_v(&img.planes[c], dims.ysize.div_ceil(1 << (vs - 1)))?;
                }
            }
        }
        let lf = &fh.loop_filter;
        if lf.gab {
            stages::gaborish(&mut img.planes[..3], lf);
        }
        if lf.epf_iters > 0 {
            let (sigma, bw) = match &df.vardct {
                Some(v) => (v.epf_inv_sigma(lf), v.xb),
                None => {
                    #[allow(clippy::excessive_precision)]
                    const INV_SIGMA_NUM: f32 = -1.1715728752538099024;
                    let bw = dims.xsize.div_ceil(8);
                    (vec![INV_SIGMA_NUM / lf.epf_sigma_for_modular; bw * dims.ysize.div_ceil(8)], bw)
                }
            };
            if lf.epf_iters >= 3 {
                stages::epf(&mut img.planes[..3], lf, &sigma, bw, 0);
            }
            stages::epf(&mut img.planes[..3], lf, &sigma, bw, 1);
            if lf.epf_iters >= 2 {
                stages::epf(&mut img.planes[..3], lf, &sigma, bw, 2);
            }
        }
        let late_ec = fh.upsampling != 1 && fh.ec_upsampling.iter().all(|&u| u == fh.upsampling);
        let (uw, uh) = (dims.xsize_upsampled, dims.ysize_upsampled);
        if !late_ec {
            for (i, &u) in fh.ec_upsampling.iter().enumerate() {
                if u != 1 {
                    let shift = crate::entropy::ceil_log2(u);
                    let k = self.kernel(shift);
                    img.planes[3 + i] = stages::upsample(&img.planes[3 + i], &k, shift, uw, uh)?;
                }
            }
        }
        if !df.patches.is_empty() {
            apply_patches(&mut img, &df.patches, &self.refs, &m.extra_channels)?;
        }
        let (ytox, ytob) = match &df.vardct {
            Some(v) => (v.cfl.ytox(0), v.cfl.ytob(0)),
            None => (0.0, 1.0),
        };
        if let Some(sp) = &df.splines {
            crate::splines::draw(sp, &mut img.planes[..3], ytox, ytob)?;
        }
        if fh.upsampling != 1 {
            let shift = crate::entropy::ceil_log2(fh.upsampling);
            let k = self.kernel(shift);
            let n = if late_ec { img.planes.len() } else { 3 };
            for c in 0..n {
                img.planes[c] = stages::upsample(&img.planes[c], &k, shift, uw, uh)?;
            }
        }
        if let Some(lut) = &df.noise {
            if lut.iter().any(|&v| v.abs() > 1e-3) {
                let mut rnd = stages::noise_planes(uw, uh, dims.group_dim, self.visible_index, self.nonvisible_index)?;
                for p in rnd.iter_mut() {
                    stages::convolve_noise(p);
                }
                stages::add_noise(&mut img.planes[..3], &rnd, lut, ytox, ytob);
            }
        }
        if fh.frame_type == FrameType::Lf {
            let lvl = fh.lf_level as usize;
            if lvl == 0 || lvl > 4 {
                return invalid("LF frame level");
            }
            self.lf_frames[lvl - 1] = Some(img.planes[..3].to_vec());
            return Ok(None);
        }
        if fh.can_be_referenced() && fh.save_before_ct {
            self.refs[fh.save_as_reference as usize] = Some(Reference { image: img.clone(), before_ct: true });
        }
        let display = matches!(fh.frame_type, FrameType::Regular | FrameType::SkipProgressive);
        let needs_ct = !fh.save_before_ct || display;
        if needs_ct {
            if fh.xyb {
                let (op, tf) = output_params(&self.hd)?;
                let gray = self.hd.metadata.colour.is_gray();
                stages::xyb_to_linear(&mut img.planes[..3], &op, gray);
                if gray {
                    stages::from_linear(&mut img.planes[..1], tf);
                    let p0 = img.planes[0].clone();
                    img.planes[1] = p0.clone();
                    img.planes[2] = p0;
                } else {
                    stages::from_linear(&mut img.planes[..3], tf);
                }
            } else if fh.ycbcr {
                stages::ycbcr_to_rgb(&mut img.planes[..3]);
            }
        }
        let canvas = if display { Some(self.blend(fh, img)?) } else { None };
        if fh.can_be_referenced() && !fh.save_before_ct {
            match &canvas {
                Some(c) => self.refs[fh.save_as_reference as usize] = Some(Reference { image: c.clone(), before_ct: false }),
                None => return Err(Error::Unsupported("reference-only frame saved after colour transform")),
            }
        }
        if display && fh.is_visible() {
            return Ok(canvas);
        }
        Ok(None)
    }

    fn kernel(&self, shift: u32) -> Vec<f32> {
        use crate::stages::{upsampling_kernel, UPS2, UPS4, UPS8};
        let t = &self.hd.transform;
        let w: &[f32] = match shift {
            1 => t.upsampling2.as_deref().unwrap_or(&UPS2),
            2 => t.upsampling4.as_deref().unwrap_or(&UPS4),
            _ => t.upsampling8.as_deref().unwrap_or(&UPS8),
        };
        upsampling_kernel(w, shift)
    }

    fn blend(&self, fh: &FrameHeader, img: FrameImage) -> Result<FrameImage> {
        let w = self.hd.size.width as usize;
        let h = self.hd.size.height as usize;
        let full = fh.x0 == 0 && fh.y0 == 0 && img.width() == w && img.height() == h;
        let replace_all = fh.blending.mode == BlendMode::Replace && fh.ec_blending.iter().all(|b| b.mode == BlendMode::Replace);
        if full && replace_all {
            return Ok(img);
        }
        let nc = img.planes.len();
        let mut canvas = FrameImage { planes: (0..nc).map(|_| Plane::new(w, h)).collect::<Result<_>>()? };
        let source_of = |c: usize| if c < 3 { fh.blending.source } else { fh.ec_blending[c - 3].source };
        let mut bgs: Vec<Option<&Plane>> = Vec::with_capacity(nc);
        for c in 0..nc {
            let r = self.refs[source_of(c) as usize].as_ref();
            let p = match r {
                Some(r) if r.image.width() != 0 => {
                    if r.before_ct {
                        return invalid("blending with a frame saved before the colour transform");
                    }
                    if r.image.width() < w || r.image.height() < h {
                        return invalid("blending background smaller than the image");
                    }
                    r.image.planes.get(c)
                }
                _ => None,
            };
            bgs.push(p);
        }
        let color = PatchBlending::from_frame(&fh.blending);
        let ec: Vec<PatchBlending> = fh.ec_blending.iter().map(PatchBlending::from_frame).collect();
        blend_rect(&mut canvas, &bgs, &img, i64::from(fh.x0), i64::from(fh.y0), &color, &ec, &self.hd.metadata.extra_channels);
        Ok(canvas)
    }
}

/// libjxl's int_to_float for floating-point samples stored as integers.
fn int_to_float(v: i32, bits: u32, exp_bits: u32) -> f32 {
    if bits == 32 {
        return f32::from_bits(v as u32);
    }
    let exp_bias = (1i32 << (exp_bits - 1)) - 1;
    let sign_shift = bits - 1;
    let mant_bits = bits - exp_bits - 1;
    let mant_shift = 23 - mant_bits;
    let mut f = v as u32;
    let sign = (f >> sign_shift) & 1;
    f &= (1u32 << sign_shift) - 1;
    if f == 0 {
        return if sign == 1 { -0.0 } else { 0.0 };
    }
    let mut exp = (f >> mant_bits) as i32;
    let mut mant = f & ((1u32 << mant_bits) - 1);
    if exp == (1 << exp_bits) - 1 {
        return f32::from_bits((sign << 31) | (0xFF << 23) | (mant << mant_shift));
    }
    mant <<= mant_shift;
    if exp == 0 && exp_bits < 8 {
        while mant & 0x80_0000 == 0 {
            mant <<= 1;
            exp -= 1;
        }
        exp += 1;
        mant &= 0x7F_FFFF;
    }
    exp = exp - exp_bias + 127;
    if exp <= 0 {
        return if sign == 1 { -0.0 } else { 0.0 };
    }
    f32::from_bits((sign << 31) | ((exp as u32 & 0xFF) << 23) | mant)
}

fn channel_to_plane(ch: &Channel, bd: &crate::headers::BitDepth) -> Result<Plane> {
    let mut p = Plane::new(ch.w, ch.h)?;
    if ch.data.len() != ch.w * ch.h {
        return invalid("channel not decoded");
    }
    if bd.float {
        for (o, &v) in p.data.iter_mut().zip(ch.data.iter()) {
            *o = int_to_float(v, bd.bits, bd.exp_bits);
        }
    } else if bd.bits < 23 {
        let f = (1.0f64 / f64::from((1u32 << bd.bits) - 1)) as f32;
        for (o, &v) in p.data.iter_mut().zip(ch.data.iter()) {
            *o = v as f32 * f;
        }
    } else {
        let f = 1.0f64 / ((1u64 << bd.bits) - 1) as f64;
        for (o, &v) in p.data.iter_mut().zip(ch.data.iter()) {
            *o = (f64::from(v) * f) as f32;
        }
    }
    Ok(p)
}

/// Converts the decoded samples to float planes (3 colour + extra channels).
fn to_planes(hd: &Headers, fh: &FrameHeader, df: &mut DecodedFrame) -> Result<FrameImage> {
    let m = &hd.metadata;
    let chans = &df.modular.channels;
    let mut planes = Vec::with_capacity(3 + m.extra_channels.len());
    match df.nb_color {
        0 => {
            let v = df.vardct.as_mut().ok_or(Error::Invalid("frame without colour"))?;
            let dims = fh.dims();
            for c in 0..3 {
                let w = dims.xsize.div_ceil(1 << fh.hshift(c));
                let h = dims.ysize.div_ceil(1 << fh.vshift(c));
                // The block-padded plane, cropped in place (rows only move towards the start).
                let mut p = std::mem::replace(&mut v.planes[c], Plane { w: 0, h: 0, data: Vec::new() });
                if p.w < w || p.h < h {
                    return invalid("VarDCT plane smaller than the frame");
                }
                if p.w != w {
                    for y in 0..h {
                        p.data.copy_within(y * p.w..y * p.w + w, y * w);
                    }
                }
                p.data.truncate(w * h);
                p.w = w;
                p.h = h;
                planes.push(p);
            }
        }
        1 => {
            let p = channel_to_plane(&chans[0], &m.bit_depth)?;
            planes.push(p.clone());
            planes.push(p.clone());
            planes.push(p);
        }
        _ => {
            if fh.xyb {
                let (y, x, b) = (&chans[0], &chans[1], &chans[2]);
                if y.w != x.w || y.w != b.w || y.h != x.h || y.h != b.h {
                    return invalid("XYB channels differ in size");
                }
                let q = df.lf_dequant;
                let mut px = Plane::new(y.w, y.h)?;
                let mut py = Plane::new(y.w, y.h)?;
                let mut pb = Plane::new(y.w, y.h)?;
                for i in 0..y.data.len() {
                    px.data[i] = x.data[i] as f32 * q[0];
                    py.data[i] = y.data[i] as f32 * q[1];
                    pb.data[i] = b.data[i].wrapping_add(y.data[i]) as f32 * q[2];
                }
                planes.push(px);
                planes.push(py);
                planes.push(pb);
            } else {
                for c in chans.iter().take(3) {
                    planes.push(channel_to_plane(c, &m.bit_depth)?);
                }
            }
        }
    }
    for (i, ec) in m.extra_channels.iter().enumerate() {
        planes.push(channel_to_plane(&chans[df.nb_color + i], &ec.bit_depth)?);
    }
    Ok(FrameImage { planes })
}

/// Opsin inverse parameters and transfer function for the image's output colour space.
fn output_params(hd: &Headers) -> Result<(crate::stages::OpsinParams, crate::stages::OutputTf)> {
    use crate::headers::{ColourSpace, Primaries, TransferFunction, WhitePoint};
    use crate::stages::OutputTf;
    let m = &hd.metadata;
    let ce = &m.colour;
    let o = &hd.transform.opsin;
    let mut inv = [[0f32; 3]; 3];
    for j in 0..3 {
        for i in 0..3 {
            inv[j][i] = o.matrix[j][i];
        }
    }
    let can_output = !ce.want_icc
        && matches!(ce.tf, TransferFunction::Pq | TransferFunction::Srgb | TransferFunction::Gamma(_) | TransferFunction::Linear | TransferFunction::Hlg | TransferFunction::Dci | TransferFunction::Bt709)
        && !(ce.is_gray() && ce.white_point != WhitePoint::D65);
    let mut tf = if !can_output {
        OutputTf::Linear
    } else {
        match ce.tf {
            TransferFunction::Srgb => OutputTf::Srgb,
            TransferFunction::Linear => OutputTf::Linear,
            TransferFunction::Gamma(g) => OutputTf::Gamma(g as f32),
            TransferFunction::Dci => OutputTf::Gamma(1.0 / 2.6),
            TransferFunction::Bt709 => OutputTf::Bt709,
            TransferFunction::Pq => OutputTf::Pq(m.tone_mapping.intensity_target),
            TransferFunction::Hlg => {
                // HlgOOTF::ToSceneLight at the image's intensity target.
                let l = m.tone_mapping.intensity_target;
                let gamma = (1.0 / 1.2f32) * 1.111f32.powf(-(l / 1000.0).log2());
                OutputTf::Hlg(gamma - 1.0, [0.2126, 0.7152, 0.0722])
            }
            TransferFunction::Unknown => OutputTf::Linear,
        }
    };
    let gray = ce.is_gray();
    if can_output && !gray && ce.colour_space == ColourSpace::Rgb && (ce.primaries != Primaries::Srgb || ce.white_point != WhitePoint::D65) {
        // Linear sRGB to the image's primaries and white point, folded into the opsin
        // inverse matrix (libjxl's OutputEncodingInfo::SetColorEncoding).
        let srgb_to_xyzd50 = crate::colour::primaries_to_xyz_d50(crate::colour::SRGB_PRIMARIES, crate::colour::D65)?;
        let wp = crate::colour::white_point_xy(ce.white_point);
        let original_to_xyz = crate::colour::primaries_to_xyz(crate::colour::primaries_xy(ce.primaries), wp)?;
        if let OutputTf::Hlg(e, _) = tf {
            tf = OutputTf::Hlg(e, original_to_xyz[1]);
        }
        let adapt = crate::colour::adapt_to_xyz_d50(wp)?;
        let xyzd50_to_original = crate::colour::inv3(&crate::colour::mul3(&adapt, &original_to_xyz))?;
        let srgb_to_original = crate::colour::mul3(&xyzd50_to_original, &srgb_to_xyzd50);
        inv = crate::colour::mul3(&srgb_to_original, &inv);
    }
    if gray {
        let lum = [0.2126f32, 0.7152, 0.0722];
        let mut g = [0f32; 3];
        for i in 0..3 {
            g[i] = lum[0] * inv[0][i] + lum[1] * inv[1][i] + lum[2] * inv[2][i];
        }
        inv = [g, g, g];
    }
    let scale = 255.0 / m.tone_mapping.intensity_target;
    for row in inv.iter_mut() {
        for v in row.iter_mut() {
            *v *= scale;
        }
    }
    let bias = o.bias;
    let bias_cbrt = [bias[0].cbrt(), bias[1].cbrt(), bias[2].cbrt()];
    Ok((crate::stages::OpsinParams { inverse: inv, bias, bias_cbrt }, tf))
}
