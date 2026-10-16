//! JPEG XL decoder (ISO/IEC 18181-1 codestream, 18181-2 container). Pure Rust, no dependencies.
//!
//! [`decode`] returns the first displayed frame. Lossless (modular, non-XYB) images come back as
//! the exact integer sample values; everything else as floating-point samples in the image's
//! colour space (nominal range 0.0–1.0).
#![forbid(unsafe_code)]
// Constant tables are copied digit for digit from the specification and libjxl; per-channel
// loops index several parallel arrays.
#![allow(clippy::excessive_precision, clippy::needless_range_loop, clippy::too_many_arguments)]

mod bits;
mod simd;
mod colour;
mod brotli;
mod container;
mod decoder;
mod entropy;
pub mod error;
mod frame;
mod frame_header;
pub mod headers;
mod icc;
mod jpeg;
mod modular;
mod vardct;
mod render;
mod splines;
mod stages;

pub use error::{Error, Result};
pub use headers::{BitDepth, ColourEncoding, ColourSpace, ExtraChannelType, TransferFunction};

use bits::BitReader;

/// Limits applied while decoding.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Largest accepted image (width × height).
    pub max_pixels: u64,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_pixels: 1 << 28 }
    }
}

/// Samples of one channel, row-major, `width × height`.
#[derive(Clone, Debug, PartialEq)]
pub enum Plane {
    /// Exact integer samples (lossless modular data), in 0..2^bits.
    Int(Vec<i32>),
    /// Samples with nominal range 0.0–1.0.
    Float(Vec<f32>),
}

#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// 1 (grey) or 3 (RGB) colour channels come first in `planes`, then the extra channels.
    pub num_color: usize,
    pub planes: Vec<Plane>,
    /// Bit depth of the colour channels, from the image header.
    pub bit_depth: BitDepth,
    pub extra_channels: Vec<ExtraChannelType>,
    /// Colour encoding of the returned samples.
    pub colour: ColourEncoding,
    /// The embedded ICC profile, when the image has one.
    pub icc: Option<Vec<u8>>,
}

/// Header information, without decoding any frame.
#[derive(Clone, Debug)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub bit_depth: BitDepth,
    pub num_color: usize,
    pub xyb_encoded: bool,
    pub colour: ColourEncoding,
    pub num_extra_channels: usize,
    pub extra_channels: Vec<ExtraChannelType>,
}

pub fn info(data: &[u8]) -> Result<Info> {
    let parsed = container::parse(data)?;
    let mut br = BitReader::new(&parsed.codestream);
    let hd = headers::read_headers(&mut br)?;
    let s = hd.oriented_size();
    Ok(Info {
        width: s.width,
        height: s.height,
        bit_depth: hd.metadata.bit_depth,
        num_color: if hd.metadata.colour.is_gray() { 1 } else { 3 },
        xyb_encoded: hd.metadata.xyb_encoded,
        colour: hd.metadata.colour.clone(),
        num_extra_channels: hd.metadata.extra_channels.len(),
        extra_channels: hd.metadata.extra_channels.iter().map(|e| e.kind).collect(),
    })
}

/// Decodes the first displayed frame of a JPEG XL file or bare codestream.
pub fn decode(data: &[u8], opts: &Options) -> Result<Image> {
    let mut frames = decode_frames(data, opts, 1)?;
    frames.pop().ok_or(Error::Invalid("no displayed frame"))
}

/// Decodes up to `max` displayed frames (animations), as float samples except for a lone
/// lossless frame.
pub fn decode_frames(data: &[u8], opts: &Options, max: usize) -> Result<Vec<Image>> {
    let parsed = container::parse(data)?;
    let cs: &[u8] = &parsed.codestream;
    let mut dec = decoder::Decoder::new(cs)?;
    let hd = dec.hd.clone();
    let pixels = u64::from(hd.size.width) * u64::from(hd.size.height);
    if pixels > opts.max_pixels {
        return Err(Error::Limit("image too large"));
    }
    dec.allow_int = max == 1;
    // A frame may be up to 4× the image area (frames can extend past the canvas), in every
    // channel; images with more than 13 extra channels get the limit of 13.
    let nch = (3 + hd.metadata.extra_channels.len() as u64).min(16);
    dec.max_samples = opts.max_pixels.saturating_mul(4).saturating_mul(nch);
    let mut out = Vec::new();
    while out.len() < max {
        let Some((_, r)) = dec.next_displayed()? else { break };
        out.push(to_image(r, &hd));
    }
    if out.is_empty() {
        return Err(Error::Invalid("no displayed frame"));
    }
    Ok(out)
}

fn to_image(r: decoder::Rendered, hd: &headers::Headers) -> Image {
    let w = hd.size.width as usize;
    let h = hd.size.height as usize;
    let o = hd.metadata.orientation;
    let num_color = if hd.metadata.colour.is_gray() { 1 } else { 3 };
    let planes: Vec<Plane> = match r {
        decoder::Rendered::Int(chans, nb_color) => chans
            .into_iter()
            .enumerate()
            .map(|(i, ch)| {
                let bits = if i < nb_color { hd.metadata.bit_depth.bits } else { hd.metadata.extra_channels[i - nb_color].bit_depth.bits };
                let max = ((1u64 << bits) - 1) as i32;
                let mut data = ch.data;
                for v in data.iter_mut() {
                    *v = (*v).clamp(0, max);
                }
                Plane::Int(orient(data, w, h, o))
            })
            .collect(),
        decoder::Rendered::Float(img) => img
            .planes
            .into_iter()
            .enumerate()
            .filter(|(i, _)| *i >= 3 || *i < num_color)
            .map(|(_, p)| Plane::Float(orient(p.data, w, h, o)))
            .collect(),
    };
    let s = hd.oriented_size();
    Image {
        width: s.width,
        height: s.height,
        num_color,
        planes,
        bit_depth: hd.metadata.bit_depth,
        extra_channels: hd.metadata.extra_channels.iter().map(|e| e.kind).collect(),
        colour: hd.metadata.colour.clone(),
        icc: hd.icc.clone(),
    }
}

/// Applies the Exif orientation (1–8) to a `w × h` plane.
fn orient<T: Copy>(data: Vec<T>, w: usize, h: usize, orientation: u32) -> Vec<T> {
    if orientation <= 1 || orientation > 8 || data.len() != w * h {
        return data;
    }
    let transpose = orientation > 4;
    let (ow, oh) = if transpose { (h, w) } else { (w, h) };
    let mut out = Vec::with_capacity(w * h);
    for oy in 0..oh {
        for ox in 0..ow {
            // Map the output position back to the stored image.
            let (x, y) = match orientation {
                2 => (w - 1 - ox, oy),
                3 => (w - 1 - ox, h - 1 - oy),
                4 => (ox, h - 1 - oy),
                5 => (oy, ox),
                6 => (oy, h - 1 - ox),
                7 => (w - 1 - oy, h - 1 - ox),
                _ => (w - 1 - oy, ox),
            };
            out.push(data[y * w + x]);
        }
    }
    out
}

/// Writes the colour planes `planes` (1 or 3, all `Int` or all `Float`, each `n` samples) to
/// `out` as interleaved little-endian integers of `bps` (1 or 2) bytes in 0..=`max`. Integers
/// are clamped; floats become `v × max`, rounded to nearest with ties to even and clamped (NaN
/// gives 0), which is libjxl's float-to-integer conversion without its 8-bit dither.
pub fn interleave(planes: &[Plane], n: usize, max: u32, bps: usize, out: &mut [u8]) -> Result<()> {
    let ints: Option<Vec<&[i32]>> = planes.iter().map(|p| match p { Plane::Int(d) if d.len() == n => Some(&d[..]), _ => None }).collect();
    let floats: Option<Vec<&[f32]>> = planes.iter().map(|p| match p { Plane::Float(d) if d.len() == n => Some(&d[..]), _ => None }).collect();
    if out.len() != n * planes.len() * bps || !(bps == 1 || bps == 2) {
        return Err(Error::Invalid("output buffer size"));
    }
    match (ints, floats, planes.len(), bps) {
        (Some(p), _, 1, 1) => interleave_n::<_, 1, 1>(out, [p[0]], max),
        (Some(p), _, 1, _) => interleave_n::<_, 1, 2>(out, [p[0]], max),
        (Some(p), _, 3, 1) => interleave_n::<_, 3, 1>(out, [p[0], p[1], p[2]], max),
        (Some(p), _, 3, _) => interleave_n::<_, 3, 2>(out, [p[0], p[1], p[2]], max),
        (_, Some(p), 1, 1) => interleave_n::<_, 1, 1>(out, [p[0]], max),
        (_, Some(p), 1, _) => interleave_n::<_, 1, 2>(out, [p[0]], max),
        (_, Some(p), 3, 1) => interleave_n::<_, 3, 1>(out, [p[0], p[1], p[2]], max),
        (_, Some(p), 3, _) => interleave_n::<_, 3, 2>(out, [p[0], p[1], p[2]], max),
        _ => return Err(Error::Invalid("planes to interleave")),
    }
    Ok(())
}

/// Four samples converted to integers in 0..=max.
trait Quantize: Copy + Default {
    fn quantize4(v: [Self; 4], max: u32) -> [u32; 4];
}

impl Quantize for i32 {
    #[inline(always)]
    fn quantize4(v: [i32; 4], max: u32) -> [u32; 4] {
        v.map(|x| x.clamp(0, max as i32) as u32)
    }
}

impl Quantize for f32 {
    #[inline(always)]
    fn quantize4(v: [f32; 4], max: u32) -> [u32; 4] {
        use simd::F4;
        // Adding and removing 2^23 rounds to nearest, ties to even, for 0 ≤ x < 2^23.
        const M: f32 = 8_388_608.0;
        let m = F4::splat(max as f32);
        let x = F4::load(&v).mul(m).max0().min_c(m);
        x.add(F4::splat(M)).sub(F4::splat(M)).to_i32().map(|q| q as u32)
    }
}

/// `interleave` for `S` planes and `B`-byte samples, four pixels at a time.
#[inline(always)]
fn interleave_n<T: Quantize, const S: usize, const B: usize>(out: &mut [u8], planes: [&[T]; S], max: u32) {
    let n = planes[0].len();
    for (i, px) in out.chunks_mut(4 * S * B).enumerate() {
        let x = 4 * i;
        let q: [[u32; 4]; S] = core::array::from_fn(|c| {
            let v: [T; 4] = match planes[c].get(x..x + 4) {
                Some(v) => v.try_into().unwrap_or_default(),
                None => {
                    // The last, partial group of pixels.
                    let mut v = [T::default(); 4];
                    let k = n.saturating_sub(x).min(4);
                    v[..k].copy_from_slice(&planes[c][x..x + k]);
                    v
                }
            };
            T::quantize4(v, max)
        });
        for (j, p) in px.chunks_exact_mut(S * B).enumerate() {
            for c in 0..S {
                p[c * B..c * B + B].copy_from_slice(&q[c][j].to_le_bytes()[..B]);
            }
        }
    }
}

/// Rebuilds the original JPEG file from a JPEG XL file made by lossless JPEG recompression
/// (one with a `jbrd` box). The result is byte-identical to the JPEG that was recompressed.
pub fn reconstruct_jpeg(data: &[u8], opts: &Options) -> Result<Vec<u8>> {
    use frame_header::{read_toc, Encoding, FrameHeader};
    let parsed = container::parse(data)?;
    let jbrd = parsed.jbrd.ok_or(Error::Invalid("no JPEG reconstruction data (jbrd box)"))?;
    let cs: &[u8] = &parsed.codestream;
    let mut br = BitReader::new(cs);
    let hd = headers::read_headers(&mut br)?;
    if hd.metadata.xyb_encoded {
        return Err(Error::Invalid("cannot rebuild a JPEG from an XYB image"));
    }
    if u64::from(hd.size.width) * u64::from(hd.size.height) > opts.max_pixels {
        return Err(Error::Limit("image larger than max_pixels"));
    }
    let mut jd = jpeg::parse_jbrd(jbrd, brotli_decompress)?;
    let mut pos = br.byte_pos();
    if hd.metadata.preview.is_some() {
        pos = skip_frame(cs, pos, &hd, true)?;
    }
    let mut br = BitReader::new(cs.get(pos..).ok_or(Error::Invalid("frame offset"))?);
    let fh = FrameHeader::read(&mut br, &hd, false)?;
    if fh.encoding != Encoding::VarDct {
        return Err(Error::Invalid("JPEG reconstruction needs a VarDCT frame"));
    }
    let dims = fh.dims();
    let toc = read_toc(&mut br, &dims, fh.passes.num_passes as usize)?;
    let start = pos + br.byte_pos();
    let fdata = cs.get(start..).ok_or(Error::Invalid("frame data"))?;
    let mut sections = frame::Sections::new(fdata, &toc)?;
    let ncomp = jd.components.len();
    let gray = ncomp == 1;
    let c_map = if gray {
        [0, 0, 0]
    } else if fh.ycbcr {
        [1, 0, 2]
    } else {
        [0, 1, 2]
    };
    let refs: [Option<render::Reference>; 4] = [None, None, None, None];
    let lfs: [Option<Vec<render::Plane>>; 4] = [None, None, None, None];
    let df = frame::decode_frame_sections(&mut sections, &hd, &fh, &refs, &lfs, Some((gray, c_map)))?;
    let vd = df.vardct.ok_or(Error::Invalid("JPEG reconstruction needs a VarDCT frame"))?;
    let jc = vd.jpeg.ok_or(Error::Invalid("JPEG state"))?;
    jd.width = dims.xsize as u32;
    jd.height = dims.ysize as u32;
    for c in 0..ncomp {
        let k = c_map[c];
        let comp = jd.components.get_mut(k).ok_or(Error::Invalid("JPEG component"))?;
        comp.h_samp = 1 << fh.raw_hshift(c);
        comp.v_samp = 1 << fh.raw_vshift(c);
    }
    let mut qt_set = 0u32;
    for c in 0..ncomp {
        let quant_c = if gray { 1 } else { c };
        let qpos = jd.components[c_map[c]].quant_idx as usize;
        let q = jd.quant.get_mut(qpos).ok_or(Error::Invalid("JPEG quantisation table index"))?;
        qt_set |= 1 << qpos;
        for x in 0..8 {
            for y in 0..8 {
                q.values[x * 8 + y] = jc.qtable[quant_c * 64 + y * 8 + x];
            }
        }
    }
    for i in 0..jd.quant.len() {
        if qt_set & (1 << i) != 0 {
            continue;
        }
        if i == 0 {
            return Err(Error::Invalid("first JPEG quantisation table unused"));
        }
        let prev = jd.quant[i - 1].values;
        jd.quant[i].values = prev;
    }
    for (k, (w, h, coeffs)) in jc.comps.into_iter().enumerate() {
        let comp = jd.components.get_mut(k).ok_or(Error::Invalid("JPEG component"))?;
        comp.width_in_blocks = w;
        comp.height_in_blocks = h;
        comp.coeffs = coeffs;
    }
    if let Some(icc) = &hd.icc {
        jd.set_icc(icc)?;
    }
    if jd.has_exif() {
        if let Some((b, compressed)) = parsed.exif {
            let v = if compressed { brotli_decompress(b, 1 << 26)?.0 } else { b.to_vec() };
            jd.set_exif(&v)?;
        }
    }
    if jd.has_xmp() {
        if let Some((b, compressed)) = parsed.xmp {
            let v = if compressed { brotli_decompress(b, 1 << 26)?.0 } else { b.to_vec() };
            jd.set_xmp(&v)?;
        }
    }
    jd.write()
}

/// Brotli-decompresses one stream of at most `max` bytes; returns the output and the number of
/// input bytes the stream used.
fn brotli_decompress(input: &[u8], max: usize) -> Result<(Vec<u8>, usize)> {
    brotli::decompress_with_consumed(input, max).map_err(|e| Error::Invalid(e.message()))
}

/// Skips a frame using its TOC; returns the offset of the next frame.
fn skip_frame(cs: &[u8], pos: usize, hd: &headers::Headers, preview: bool) -> Result<usize> {
    let mut br = BitReader::new(cs.get(pos..).ok_or(Error::Invalid("frame offset"))?);
    let fh = frame_header::FrameHeader::read(&mut br, hd, preview)?;
    let toc = frame_header::read_toc(&mut br, &fh.dims(), fh.passes.num_passes as usize)?;
    let end = pos + br.byte_pos() + toc.total;
    if end > cs.len() {
        return Err(Error::Invalid("frame data truncated"));
    }
    Ok(end)
}
