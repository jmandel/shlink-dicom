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
    done: bool,
    /// Allow the exact integer output for a lone lossless frame.
    pub allow_int: bool,
}

impl<'a> Decoder<'a> {
    pub fn new(cs: &'a [u8]) -> Result<Self> {
        let mut br = BitReader::new(cs);
        let hd = read_headers(&mut br)?;
        let mut d = Decoder { hd, cs, pos: br.byte_pos(), refs: [None, None, None, None], done: false, allow_int: true };
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
            let dims = fh.dims();
            let toc = read_toc(&mut br, &dims, fh.passes.num_passes as usize)?;
            let start = self.pos + br.byte_pos();
            let data = self.cs.get(start..).ok_or(Error::Invalid("frame data"))?;
            let mut sections = Sections::new(data, &toc)?;
            self.pos = start + toc.total;
            if fh.is_last {
                self.done = true;
            }
            let df = decode_frame_sections(&mut sections, &self.hd, &fh, &self.refs)?;
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
            && df.nb_color > 0
    }

    /// Renders a decoded frame; returns the canvas when the frame is displayed.
    fn render(&mut self, fh: &FrameHeader, df: DecodedFrame) -> Result<Option<FrameImage>> {
        let m = &self.hd.metadata;
        let mut img = to_planes(&self.hd, fh, &df)?;
        if fh.loop_filter.gab || fh.loop_filter.epf_iters > 0 {
            return Err(Error::Unsupported("loop filters"));
        }
        if fh.upsampling != 1 || fh.ec_upsampling.iter().any(|&u| u != 1) {
            return Err(Error::Unsupported("upsampling"));
        }
        if !df.patches.is_empty() {
            apply_patches(&mut img, &df.patches, &self.refs, &m.extra_channels)?;
        }
        if fh.frame_type == FrameType::Lf {
            return Err(Error::Unsupported("LF frames"));
        }
        if fh.can_be_referenced() && fh.save_before_ct {
            self.refs[fh.save_as_reference as usize] = Some(Reference { image: img.clone(), before_ct: true });
        }
        if fh.xyb || fh.ycbcr {
            return Err(Error::Unsupported("colour transforms"));
        }
        let display = matches!(fh.frame_type, FrameType::Regular | FrameType::SkipProgressive);
        let canvas = if display { Some(self.blend(fh, img)?) } else { None };
        if let Some(c) = &canvas {
            if fh.can_be_referenced() && !fh.save_before_ct {
                self.refs[fh.save_as_reference as usize] = Some(Reference { image: c.clone(), before_ct: false });
            }
        } else if fh.can_be_referenced() && !fh.save_before_ct {
            return Err(Error::Unsupported("reference-only frame saved after colour transform"));
        }
        if display && fh.is_visible() {
            return Ok(canvas);
        }
        Ok(None)
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
fn to_planes(hd: &Headers, fh: &FrameHeader, df: &DecodedFrame) -> Result<FrameImage> {
    let m = &hd.metadata;
    let chans = &df.modular.channels;
    let mut planes = Vec::with_capacity(3 + m.extra_channels.len());
    match df.nb_color {
        0 => return Err(Error::Unsupported("VarDCT colour")),
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
