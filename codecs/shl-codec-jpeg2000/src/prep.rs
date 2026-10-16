//! Checks and output handling shared by the JPEG 2000 and HTJ2K wrappers.
//!
//! Neither wrapped crate may see a codestream whose image header disagrees with the DICOM
//! data set: both allocate from SIZ before decoding anything, and a corrupt SIZ (for example
//! Xsiz = 0xFEFFDDE0 in `pydicom-JPEG2000-embedded-sequence-delimiter`) makes them try to
//! allocate terabytes, which aborts the process. So [`prepare`] strips any JP2 wrapper, reads
//! the main header itself and refuses anything that does not describe exactly the frame the
//! data set declares. [`pack`] then turns per-component samples into the canonical frame.

use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Photometric, Result};

/// Highest component precision accepted. DICOM JPEG 2000 data is at most 16 bits stored, and
/// the decoder's irreversible path works in f32, which is exact only up to 24 bits.
pub const MAX_PRECISION: u8 = 16;

/// The standard limits a codestream to 65535 tiles (Isot is 16 bits, and 65535 is reserved).
pub const MAX_TILES: u64 = 65_535;

const SOC: u16 = 0xFF4F;
const SIZ: u16 = 0xFF51;
const COD: u16 = 0xFF52;
const SOT: u16 = 0xFF90;
/// JPEG 2000 Part 2 (T.801 A.3.6, A.3.9): component bit depths, transformation ordering.
const CBD: u16 = 0xFF78;
const MCO: u16 = 0xFF77;
/// Rsiz: Part 2, with the multiple component transformation capability (T.801 Table A.2).
const RSIZ_PART2: u16 = 0x8000;
const RSIZ_MCT: u16 = 0x0100;

pub const JP2_SIGNATURE: [u8; 12] = [0, 0, 0, 0x0C, b'j', b'P', b' ', b' ', 0x0D, 0x0A, 0x87, 0x0A];

/// One SIZ component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Component {
    /// Bits per sample, 1..=38.
    pub precision: u8,
    pub signed: bool,
    pub dx: u8,
    pub dy: u8,
}

/// The parts of the main header the wrappers need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MainHeader {
    pub width: u32,
    pub height: u32,
    /// Image offset on the reference grid (XOsiz, YOsiz).
    pub x0: u32,
    pub y0: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub tiles: u64,
    /// The image components the decoder returns: the SIZ components, or after a Part 2
    /// multiple component transformation the CBD components (not subsampled).
    pub components: Vec<Component>,
    /// COD's Part 1 multiple component transformation flag (RCT or ICT; main header).
    pub mct: bool,
    /// A Part 2 multiple component transformation (T.801 Annex J) is used: Rsiz has the
    /// capability, COD selects the array-based transformation and MCO has at least one stage.
    /// `components` then come from CBD and get no DC level shift.
    pub part2: bool,
    /// The SIZ components (the codestream components, which differ from `components` when
    /// `part2` is set).
    pub codestream_components: Vec<Component>,
}

/// A frame that passed every check, ready for the wrapped decoder.
#[derive(Debug, Clone)]
pub struct Prepared<'a> {
    /// The raw codestream, from SOC to the end of the frame (any JP2 wrapper removed).
    pub codestream: &'a [u8],
    pub header: MainHeader,
}

impl Prepared<'_> {
    /// Precision shared by every component (checked by [`prepare`]).
    pub fn precision(&self) -> u8 {
        self.header.components.first().map_or(8, |c| c.precision)
    }

    /// `Some((dx, dy))` when the chroma components are subsampled. [`prepare`] accepts this
    /// only in the shapes OpenJPEG converts from sYCC to RGB: three unsigned components,
    /// the first not subsampled, the other two both 2x1 (4:2:2) or 2x2 (4:2:0), no MCT, and
    /// an image offset that is a multiple of the subsampling.
    pub fn sycc(&self) -> Option<(u8, u8)> {
        let c = self.header.components.get(1)?;
        (c.dx != 1 || c.dy != 1).then_some((c.dx, c.dy))
    }

    /// Size of component `c` on its own grid (T.800 B-2), at most the image size.
    pub fn component_size(&self, c: usize) -> (u32, u32) {
        let h = &self.header;
        let comp = h.components.get(c).copied().unwrap_or(Component { precision: 8, signed: false, dx: 1, dy: 1 });
        let span = |o: u32, n: u32, d: u8| {
            let d = u64::from(d);
            let end = u64::from(o) + u64::from(n);
            (end.div_ceil(d) - u64::from(o).div_ceil(d)) as u32
        };
        (span(h.x0, h.width, comp.dx), span(h.y0, h.height, comp.dy))
    }
}

fn invalid(msg: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(msg.into())
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at.checked_add(1)?)?]))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be64(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at.checked_add(8)?)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Some(u64::from_be_bytes(a))
}

/// If `data` is a JP2 (or JPH) file, return the payload of its contiguous codestream box,
/// to the end of the buffer: a DICOM fragment's even-length pad byte may follow the box,
/// and the decoders stop at EOC anyway. A raw codestream is returned unchanged.
pub fn unwrap_jp2(data: &[u8]) -> Result<&[u8]> {
    if !data.starts_with(&JP2_SIGNATURE) {
        return Ok(data);
    }
    let mut pos = 0usize;
    while pos < data.len() {
        let lbox = be32(data, pos).ok_or_else(|| invalid("truncated JP2 box header"))?;
        let tbox = data.get(pos + 4..pos + 8).ok_or_else(|| invalid("truncated JP2 box header"))?;
        let (header_len, box_len) = match lbox {
            0 => (8usize, None),
            1 => {
                let xl = be64(data, pos + 8).ok_or_else(|| invalid("truncated JP2 box header"))?;
                (16, Some(xl))
            }
            2..=7 => return Err(invalid("JP2 box length below its header size")),
            n => (8, Some(u64::from(n))),
        };
        if tbox == b"jp2c" {
            return data.get(pos + header_len..).ok_or_else(|| invalid("truncated JP2 codestream box"));
        }
        match box_len {
            None => break,
            Some(l) => {
                if l < header_len as u64 {
                    return Err(invalid("JP2 box length below its header size"));
                }
                let l = usize::try_from(l).map_err(|_| invalid("JP2 box too long"))?;
                pos = pos.checked_add(l).ok_or_else(|| invalid("JP2 box too long"))?;
            }
        }
    }
    Err(invalid("JP2 file has no codestream box"))
}

/// Read SIZ and the main-header COD from a raw codestream.
pub fn read_main_header(cs: &[u8]) -> Result<MainHeader> {
    if be16(cs, 0) != Some(SOC) {
        return Err(invalid("codestream does not start with SOC"));
    }
    if be16(cs, 2) != Some(SIZ) {
        return Err(invalid("SIZ does not follow SOC"));
    }
    let lsiz = usize::from(be16(cs, 4).ok_or_else(|| invalid("truncated SIZ"))?);
    let siz = cs.get(4..4 + lsiz).ok_or_else(|| invalid("truncated SIZ"))?;
    let rsiz = be16(siz, 2).ok_or_else(|| invalid("truncated SIZ"))?;
    // siz[0..2] Lsiz, [2..4] Rsiz, then Xsiz Ysiz XOsiz YOsiz XTsiz YTsiz XTOsiz YTOsiz, Csiz.
    let f = |i: usize| be32(siz, 4 + 4 * i).ok_or_else(|| invalid("truncated SIZ"));
    let (xsiz, ysiz, xo, yo) = (f(0)?, f(1)?, f(2)?, f(3)?);
    let (xt, yt, xto, yto) = (f(4)?, f(5)?, f(6)?, f(7)?);
    let csiz = usize::from(be16(siz, 36).ok_or_else(|| invalid("truncated SIZ"))?);
    if csiz == 0 || lsiz != 38 + 3 * csiz {
        return Err(invalid(format!("SIZ length {lsiz} does not match {csiz} components")));
    }
    if xsiz <= xo || ysiz <= yo {
        return Err(invalid("SIZ image area is empty"));
    }
    if xt == 0 || yt == 0 {
        return Err(invalid("SIZ tile size is zero"));
    }
    // T.800 A.5.1: XTOsiz <= XOsiz < XTOsiz + XTsiz, likewise for Y.
    if xto > xo || yto > yo || u64::from(xto) + u64::from(xt) <= u64::from(xo) || u64::from(yto) + u64::from(yt) <= u64::from(yo) {
        return Err(invalid("SIZ tile grid does not cover the image origin"));
    }
    let tiles_x = (u64::from(xsiz) - u64::from(xto)).div_ceil(u64::from(xt));
    let tiles_y = (u64::from(ysiz) - u64::from(yto)).div_ceil(u64::from(yt));
    let tiles = tiles_x * tiles_y;
    if tiles > MAX_TILES {
        return Err(invalid(format!("{tiles} tiles exceeds the codestream limit of {MAX_TILES}")));
    }
    let mut components = Vec::with_capacity(csiz);
    for c in 0..csiz {
        let at = 38 + 3 * c;
        let (ssiz, dx, dy) = match siz.get(at..at + 3) {
            Some(s) => (s[0], s[1], s[2]),
            None => return Err(invalid("truncated SIZ")),
        };
        let precision = (ssiz & 0x7F) + 1;
        if precision > 38 || dx == 0 || dy == 0 {
            return Err(invalid("SIZ component parameters out of range"));
        }
        components.push(Component { precision, signed: ssiz & 0x80 != 0, dx, dy });
    }

    // Walk the rest of the main header (marker segments) up to the first SOT, for COD.
    let mut pos = 4 + lsiz;
    let mut mct = None;
    let mut cbd: Option<&[u8]> = None;
    let mut mco_stages = 0usize;
    loop {
        let marker = be16(cs, pos).ok_or_else(|| invalid("main header ends before the first tile"))?;
        if marker == SOT {
            break;
        }
        if marker >> 8 != 0xFF || marker < 0xFF30 {
            return Err(invalid(format!("unexpected 0x{marker:04X} in the main header")));
        }
        let len = usize::from(be16(cs, pos + 2).ok_or_else(|| invalid("truncated main header"))?);
        if len < 2 {
            return Err(invalid("marker segment length below 2"));
        }
        if marker == COD && mct.is_none() {
            // Lcod(2) Scod(1) progression(1) layers(2) MCT(1)
            let b = cs.get(pos + 2 + 6).ok_or_else(|| invalid("truncated COD"))?;
            if len < 12 {
                return Err(invalid("COD too short"));
            }
            mct = Some(*b);
        }
        if marker == CBD {
            cbd = cs.get(pos + 4..pos + 2 + len);
        }
        if marker == MCO {
            mco_stages = usize::from(*cs.get(pos + 4).ok_or_else(|| invalid("truncated MCO"))?);
        }
        pos = pos.checked_add(2 + len).ok_or_else(|| invalid("main header overflow"))?;
    }
    let mct = mct.ok_or_else(|| invalid("main header has no COD"))?;
    let part2 = rsiz & RSIZ_PART2 != 0 && rsiz & RSIZ_MCT != 0 && mct == 2 && mco_stages > 0;
    let codestream_components = components.clone();
    if part2 {
        // CBD (T.801 A.3.6): Ncbd, then one bit depth per component, or one for all.
        let b = cbd.ok_or_else(|| invalid("Part 2 multiple component transformation without CBD"))?;
        let n = be16(b, 0).ok_or_else(|| invalid("truncated CBD"))?;
        let count = usize::from(n & 0x7FFF);
        let depth = |d: u8| Component { precision: (d & 0x7F) + 1, signed: d & 0x80 != 0, dx: 1, dy: 1 };
        components = match (n & 0x8000 != 0, b.get(2..)) {
            (true, Some([d])) => vec![depth(*d); count],
            (false, Some(ds)) if ds.len() == count => ds.iter().map(|&d| depth(d)).collect(),
            _ => return Err(invalid("CBD length does not match its component count")),
        };
        if count == 0 || components.iter().any(|c| c.precision > 38) {
            return Err(invalid("CBD component parameters out of range"));
        }
    }

    Ok(MainHeader {
        width: xsiz - xo,
        height: ysiz - yo,
        x0: xo,
        y0: yo,
        tile_width: xt,
        tile_height: yt,
        tiles,
        components,
        mct: mct == 1,
        part2,
        codestream_components,
    })
}

/// Strip any JP2 wrapper, read the main header, and refuse it unless it describes exactly
/// the frame in `info`: same size and number of components, no subsampling, one precision
/// for every component, at most Bits Allocated (and at most [`MAX_PRECISION`]). A Part 2
/// multiple component transformation is `Unsupported` here; [`prepare_part2`] accepts it.
pub fn prepare<'a>(data: &'a [u8], info: &FrameInfo) -> Result<Prepared<'a>> {
    let prep = prepare_part2(data, info, false)?;
    if prep.header.part2 {
        return Err(DecodeError::Unsupported("JPEG 2000 Part 2 multiple component transformation".into()));
    }
    Ok(prep)
}

/// [`prepare`], also accepting a Part 2 multiple component transformation (T.801 Annex J),
/// whose output components are checked instead of the SIZ components. With `frames`, the
/// codestream may hold several frames: its components are then a multiple of Samples per
/// Pixel, frame by frame (DICOM PS3.5 A.4.4, volumetric JPEG 2000 Part 2).
pub fn prepare_part2<'a>(data: &'a [u8], info: &FrameInfo, frames: bool) -> Result<Prepared<'a>> {
    let codestream = unwrap_jp2(data)?;
    let header = read_main_header(codestream)?;
    if header.width != info.columns || header.height != info.rows {
        return Err(invalid(format!(
            "codestream is {}x{}, data set says {}x{}",
            header.width, header.height, info.columns, info.rows
        )));
    }
    let spp = usize::from(info.samples_per_pixel);
    let fits = if frames { spp > 0 && header.components.len().is_multiple_of(spp) } else { header.components.len() == spp };
    if !fits {
        return Err(invalid(format!(
            "codestream has {} components, data set says {} samples per pixel",
            header.components.len(),
            info.samples_per_pixel
        )));
    }
    if !matches!(info.bits_allocated, 8 | 16 | 32) {
        return Err(DecodeError::Unsupported(format!("Bits Allocated {} with JPEG 2000", info.bits_allocated)));
    }
    let first = header.components[0];
    if header.part2 {
        if header.codestream_components.iter().any(|c| c.dx != 1 || c.dy != 1) {
            return Err(DecodeError::Unsupported(
                "JPEG 2000 Part 2 multiple component transformation of subsampled components".into(),
            ));
        }
        // Hayro works in f32; the codestream components may carry a few more bits than the
        // output, but not more than f32 holds exactly.
        if header.codestream_components.iter().any(|c| c.precision > 24) {
            return Err(DecodeError::Unsupported("JPEG 2000 codestream component precision above 24".into()));
        }
    } else if header.components.iter().any(|c| c.dx != 1 || c.dy != 1) {
        check_sycc(&header)?;
    }
    for c in &header.components {
        if c.precision != first.precision {
            return Err(invalid("JPEG 2000 components have different precisions"));
        }
    }
    if u16::from(first.precision) > info.bits_allocated {
        return Err(invalid(format!(
            "codestream precision {} exceeds Bits Allocated {}",
            first.precision, info.bits_allocated
        )));
    }
    if first.precision > MAX_PRECISION {
        return Err(DecodeError::Unsupported(format!("JPEG 2000 precision {}", first.precision)));
    }
    Ok(Prepared { codestream, header })
}

/// Subsampled components are accepted only in the layouts OpenJPEG converts from sYCC
/// (see [`Prepared::sycc`]); anything else is `Unsupported`.
fn check_sycc(h: &MainHeader) -> Result<()> {
    let unsupported = |why: &str| Err(DecodeError::Unsupported(format!("subsampled JPEG 2000 components: {why}")));
    let [y, cb, cr] = h.components.as_slice() else {
        return unsupported("only three-component colour images may be subsampled");
    };
    if y.dx != 1 || y.dy != 1 || cb != cr || !matches!((cb.dx, cb.dy), (2, 1) | (2, 2)) {
        return unsupported("only 4:2:2 and 4:2:0 chroma are handled");
    }
    if h.mct || y.signed || cb.signed {
        return unsupported("with a component transform or signed samples");
    }
    if !h.x0.is_multiple_of(u32::from(cb.dx)) || !h.y0.is_multiple_of(u32::from(cb.dy)) {
        return unsupported("with an image offset that is not a multiple of the subsampling");
    }
    Ok(())
}

/// Build the canonical frame. `sample(c, cx, cy)` returns component `c` at column `cx`,
/// row `cy` of that component's own grid (the pixel position unless it is subsampled), as a
/// signed integer in the component's SIZ range: for a signed component, already without the
/// DC level shift. Values are clamped to that range here anyway.
///
/// Colour: three-component output is RGB: the codestream's RCT/ICT was undone, or there was
/// none and the samples are returned as decoded (coordinator ruling), except that YBR_FULL
/// without MCT is returned as declared for the CLI to convert (PS3.5 8.2.4). Subsampled
/// chroma is converted from YCbCr to RGB here exactly as OpenJPEG's
/// `sycc422_to_rgb`/`sycc420_to_rgb` do (opj_decompress and pylibjpeg-openjpeg both treat
/// such codestreams as sYCC).
///
/// Signedness follows pydicom (CONTRACT, "Sign"): only for MONOCHROME images, when the
/// codestream's signedness differs from Pixel Representation, the stored value is
/// reinterpreted from the codestream precision: unsigned samples of a signed data set are
/// sign-extended from bit p−1, and signed samples of an unsigned data set keep their low
/// p bits. Everything else is written as decoded; the CLI masks or sign-extends to Bits Stored.
pub fn pack(info: &FrameInfo, prep: &Prepared<'_>, sample: impl Fn(usize, usize, usize) -> i32) -> Result<DecodedFrame> {
    let bytes = info.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    let (w, h) = (info.columns as usize, info.rows as usize);
    let bps = info.bytes_per_sample();
    let mut out = Vec::new();
    let put = |out: &mut Vec<u8>, v: i32| match bps {
        1 => out.push(v as u8),
        2 => out.extend_from_slice(&(v as u16).to_le_bytes()),
        _ => out.extend_from_slice(&v.to_le_bytes()),
    };
    let comps = component_rules(info, prep);
    let mut color = color_out(info, prep);
    if let Some((dx, dy)) = prep.sycc() {
        out.reserve(bytes);
        let (dx, dy) = (usize::from(dx), usize::from(dy));
        let upb = comps[0].1;
        let offset = (upb + 1) / 2;
        for y in 0..h {
            for x in 0..w {
                let yv = sample(0, x, y).clamp(0, upb);
                let cb = sample(1, x / dx, y / dy).clamp(0, upb);
                let cr = sample(2, x / dx, y / dy).clamp(0, upb);
                for v in sycc_to_rgb(offset, upb, yv, cb, cr) {
                    put(&mut out, v);
                }
            }
        }
        color = ColorOut::Rgb;
    } else {
        out.reserve(bytes);
        for y in 0..h {
            for x in 0..w {
                for (c, &(lo, hi, fix)) in comps.iter().enumerate() {
                    let v = sample(c, x, y).clamp(lo, hi);
                    let v = match fix {
                        Fix::None => v,
                        Fix::SignExtend(s) => (v << s) >> s,
                        Fix::Mask(m) => (v as u32 & m) as i32,
                    };
                    put(&mut out, v);
                }
            }
        }
    }
    if out.len() != bytes {
        return Err(invalid("decoded frame has the wrong size"));
    }
    Ok(DecodedFrame { data: out, planar: false, color })
}

/// Per component: the SIZ range `(lo, hi)` samples are clamped to, and the signedness fix
/// ([`pack`] doc).
fn component_rules(info: &FrameInfo, prep: &Prepared<'_>) -> Vec<(i32, i32, Fix)> {
    let mono = matches!(info.photometric, Photometric::Monochrome1 | Photometric::Monochrome2);
    prep.header
        .components
        .iter()
        .map(|c| {
            let p = u32::from(c.precision);
            let (lo, hi) = if c.signed { (-(1i32 << (p - 1)), (1i32 << (p - 1)) - 1) } else { (0, ((1i64 << p) - 1) as i32) };
            let fix = match (mono, c.signed, info.pixel_representation) {
                (true, false, 1) if p < 32 => Fix::SignExtend(32 - p),
                (true, true, 0) => Fix::Mask(((1u64 << p) - 1) as u32),
                _ => Fix::None,
            };
            (lo, hi, fix)
        })
        .collect()
}

/// Colour (FORMAT.md, Rulings): a colour frame is RGB once decoded when the decoder undid
/// RCT/ICT, and also when the codestream has no MCT, whatever the label says (coordinator
/// ruling; all three references output YBR_ICT-labelled data without MCT unchanged). The
/// one exception is YBR_FULL without MCT: PS3.5 8.2.4 says the components then are what
/// the Photometric Interpretation says, so the CLI converts them as pydicom does.
/// Subsampled chroma is converted to RGB by [`pack`].
fn color_out(info: &FrameInfo, prep: &Prepared<'_>) -> ColorOut {
    let ybr_full = matches!(info.photometric, Photometric::YbrFull) && !prep.header.mct;
    if prep.header.components.len() == 3 && !ybr_full { ColorOut::Rgb } else { ColorOut::AsDeclared }
}

/// [`pack`] for decoders that can hand over whole rows: `fill(c, y, row)` writes the `w`
/// samples of component `c`, row `y` (the decoder's value, before clamping) into `row`.
/// The output is exactly what [`pack`] writes for the same samples; this exists for speed,
/// since the per-sample callback of [`pack`] cannot be vectorised. Returns None, without
/// calling `fill`, when the frame needs [`pack`]: subsampled chroma, or a sample width
/// other than 1, 2 or 4 bytes.
pub fn pack_rows(
    info: &FrameInfo,
    prep: &Prepared<'_>,
    mut fill: impl FnMut(usize, usize, &mut [i32]),
) -> Option<Result<DecodedFrame>> {
    let bytes = info.frame_bytes()?;
    let (w, h) = (info.columns as usize, info.rows as usize);
    let bps = info.bytes_per_sample();
    let comps = component_rules(info, prep);
    let n = comps.len();
    if prep.sycc().is_some() || n == 0 || w == 0 || w.checked_mul(h)?.checked_mul(n)?.checked_mul(bps)? != bytes {
        return None;
    }
    let mut out = vec![0u8; bytes];
    let mut row = vec![0i32; w];
    match bps {
        1 => write_rows::<1>(&mut out, &mut row, &comps, &mut fill),
        2 => write_rows::<2>(&mut out, &mut row, &comps, &mut fill),
        4 => write_rows::<4>(&mut out, &mut row, &comps, &mut fill),
        _ => return None,
    }
    Some(Ok(DecodedFrame { data: out, planar: false, color: color_out(info, prep) }))
}

fn write_rows<const BPS: usize>(
    out: &mut [u8],
    row: &mut [i32],
    comps: &[(i32, i32, Fix)],
    fill: &mut impl FnMut(usize, usize, &mut [i32]),
) {
    let n = comps.len();
    let w = row.len();
    for (y, line) in out.chunks_exact_mut(w * n * BPS).enumerate() {
        for (c, &(lo, hi, fix)) in comps.iter().enumerate() {
            fill(c, y, row);
            match fix {
                Fix::None => row.iter_mut().for_each(|v| *v = (*v).clamp(lo, hi)),
                Fix::SignExtend(s) => row.iter_mut().for_each(|v| *v = ((*v).clamp(lo, hi) << s) >> s),
                Fix::Mask(m) => row.iter_mut().for_each(|v| *v = ((*v).clamp(lo, hi) as u32 & m) as i32),
            }
            if n == 1 && BPS == 2 {
                for (dst, &v) in line.chunks_exact_mut(2).zip(row.iter()) {
                    let b = (v as u16).to_le_bytes();
                    dst[0] = b[0];
                    dst[1] = b[1];
                }
            } else if n == 1 {
                for (dst, v) in line.chunks_exact_mut(BPS).zip(row.iter()) {
                    dst.copy_from_slice(&v.to_le_bytes()[..BPS]);
                }
            } else {
                for (dst, v) in line.chunks_exact_mut(BPS * n).zip(row.iter()) {
                    dst[c * BPS..(c + 1) * BPS].copy_from_slice(&v.to_le_bytes()[..BPS]);
                }
            }
        }
    }
}

/// `x.round() as i32` (round half away from zero, saturating, NaN to 0) without the libm
/// `roundf` call, which is not inlined on baseline x86-64 or wasm32. `x - trunc(x)` is exact
/// in f32, so the comparison with 0.5 decides exactly as `round` does.
#[inline(always)]
pub fn round_to_i32(x: f32) -> i32 {
    let t = x as i32;
    let f = x - t as f32;
    // Branch-free: on lossy data the fraction is random, and a branch would mispredict.
    t.saturating_add(i32::from(f >= 0.5) - i32::from(f <= -0.5))
}

/// `round_to_i32(x.clamp(lo, hi))` (NaN to 0) for bounds within ±2^22, in a form that
/// vectorises (Rust's saturating `as` does not, on x86-64 without AVX-512). Adding 1.5·2^23
/// rounds to the nearest integer, ties to even, and the bits of the sum are that integer
/// plus a constant; an exact tie (`x - r` = ±0.5, computed exactly) is then moved away from
/// zero, as `round` does.
#[inline(always)]
pub fn round_clamped(x: f32, lo: f32, hi: f32) -> i32 {
    const MAGIC: f32 = 12_582_912.0; // 1.5 * 2^23, bits 0x4B40_0000
    debug_assert!(lo.abs() <= 4_194_304.0 && hi.abs() <= 4_194_304.0);
    let x = if x.is_nan() { 0.0 } else { x }.clamp(lo, hi);
    let r = ((x + MAGIC).to_bits() as i32).wrapping_sub(0x4B40_0000);
    let d = x - r as f32;
    r + i32::from(d == 0.5 && x > 0.0) - i32::from(d == -0.5 && x < 0.0)
}

/// OpenJPEG's `sycc_to_rgb` (src/bin/common/color.c): f64 products truncated toward zero.
fn sycc_to_rgb(offset: i32, upb: i32, y: i32, cb: i32, cr: i32) -> [i32; 3] {
    let (cb, cr) = (f64::from(cb - offset), f64::from(cr - offset));
    let r = y + (1.402 * cr) as i32;
    let g = y - (0.344 * cb + 0.714 * cr) as i32;
    let b = y + (1.772 * cb) as i32;
    [r.clamp(0, upb), g.clamp(0, upb), b.clamp(0, upb)]
}

#[derive(Debug, Clone, Copy)]
enum Fix {
    None,
    SignExtend(u32),
    Mask(u32),
}

#[cfg(test)]
mod round_tests {
    use super::round_to_i32;

    /// `round_to_i32` agrees with `round() as i32` on the edge cases and on a sweep.
    #[test]
    fn matches_round() {
        let mut xs = vec![
            0.0f32, -0.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999997, -0.49999997, 0.50000006,
            8388607.5, -8388607.5, 8388608.0, 16777217.0, 2147483520.0, 2147483648.0, -2147483648.0,
            -2147483904.0, 3e9, -3e9, f32::MAX, f32::MIN, f32::INFINITY, f32::NEG_INFINITY, f32::NAN,
            f32::MIN_POSITIVE, -f32::MIN_POSITIVE, 1e-40,
        ];
        let mut b = 0x3f00_0000u32;
        for _ in 0..200_000 {
            b = b.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            xs.push(f32::from_bits(b));
            xs.push((b % 200_000) as f32 / 4.0 - 25_000.0);
        }
        for &x in &xs {
            assert_eq!(round_to_i32(x), x.round() as i32, "x = {x:e} ({:#x})", x.to_bits());
        }
        for (lo, hi) in [(-1.0f32, 256.0), (-32769.0, 32768.0), (-1.0, 65536.0), (-4_194_304.0, 4_194_304.0)] {
            for &x in &xs {
                let want = round_to_i32(x.clamp(lo, hi));
                assert_eq!(super::round_clamped(x, lo, hi), want, "x = {x:e}, [{lo}, {hi}]");
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A minimal main header: SOC, SIZ, COD, SOT.
    pub(crate) fn header(w: u32, h: u32, comps: &[(u8, bool)], tile: (u32, u32), mct: bool) -> Vec<u8> {
        let mut v = vec![0xFF, 0x4F, 0xFF, 0x51];
        let lsiz = 38 + 3 * comps.len() as u16;
        v.extend_from_slice(&lsiz.to_be_bytes());
        v.extend_from_slice(&0u16.to_be_bytes());
        for x in [w, h, 0, 0, tile.0, tile.1, 0, 0] {
            v.extend_from_slice(&x.to_be_bytes());
        }
        v.extend_from_slice(&(comps.len() as u16).to_be_bytes());
        for &(p, s) in comps {
            v.extend_from_slice(&[(p - 1) | if s { 0x80 } else { 0 }, 1, 1]);
        }
        v.extend_from_slice(&[0xFF, 0x52, 0, 12, 0, 0, 0, 1, u8::from(mct), 5, 4, 4, 0, 0]);
        v.extend_from_slice(&[0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 0, 0, 1]);
        v
    }

    fn info(rows: u32, cols: u32, spp: u16, ba: u16, bs: u16, pr: u16, ph: Photometric) -> FrameInfo {
        FrameInfo {
            rows,
            columns: cols,
            samples_per_pixel: spp,
            bits_allocated: ba,
            bits_stored: bs,
            pixel_representation: pr,
            photometric: ph,
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.90".into(),
        }
    }

    /// `pack_rows` writes exactly what `pack` writes, for every sign, width and fix rule.
    #[test]
    fn pack_rows_matches_pack() {
        let mut seed = 12345u32;
        let mut rnd = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };
        let cases: &[(u8, bool, u16, u16, u16, Photometric)] = &[
            (8, false, 1, 8, 0, Photometric::Monochrome2),
            (12, false, 1, 16, 0, Photometric::Monochrome2),
            (12, false, 1, 16, 1, Photometric::Monochrome2), // sign-extend fix
            (16, true, 1, 16, 1, Photometric::Monochrome1),
            (16, true, 1, 16, 0, Photometric::Monochrome2), // mask fix
            (16, false, 1, 32, 0, Photometric::Monochrome2),
            (8, false, 3, 8, 0, Photometric::Rgb),
            (8, false, 3, 8, 0, Photometric::YbrFull),
            (12, true, 3, 16, 1, Photometric::Rgb),
        ];
        for &(p, signed, spp, ba, pr, ph) in cases {
            let (w, h) = (7u32, 5u32);
            let cs = header(w, h, &vec![(p, signed); spp as usize], (w, h), spp == 3);
            let fi = info(h, w, spp, ba, p.into(), pr, ph);
            let prep = prepare(&cs, &fi).unwrap();
            let n = usize::from(spp) * (w * h) as usize;
            let vals: Vec<i32> = (0..n).map(|_| (rnd() as i32) >> (rnd() % 31)).collect();
            let at = |c: usize, x: usize, y: usize| vals[(y * w as usize + x) * usize::from(spp) + c];
            let a = pack(&fi, &prep, at).unwrap();
            let b = pack_rows(&fi, &prep, |c, y, row| {
                for (x, v) in row.iter_mut().enumerate() {
                    *v = at(c, x, y);
                }
            })
            .unwrap()
            .unwrap();
            assert_eq!(a.data, b.data, "{p} {signed} {spp} {ba} {pr} {ph:?}");
            assert_eq!(format!("{:?}", a.color), format!("{:?}", b.color));
        }
    }

    #[test]
    fn reads_siz_and_cod() {
        let h = read_main_header(&header(30, 20, &[(8, false); 3], (16, 16), true)).unwrap();
        assert_eq!((h.width, h.height, h.tiles, h.mct), (30, 20, 4, true));
        assert_eq!(h.components.len(), 3);
    }

    #[test]
    fn refuses_size_mismatch_before_decoding() {
        let mut cs = header(0xFEFF_DDE0, 1024, &[(16, true)], (0xFEFF_DDE0, 1024), false);
        cs.extend_from_slice(&[0xFF, 0xD9]);
        let e = prepare(&cs, &info(1024, 256, 1, 16, 16, 1, Photometric::Monochrome2)).unwrap_err();
        assert!(matches!(e, DecodeError::Invalid(_)));
    }

    #[test]
    fn refuses_components_and_precision() {
        let cs = header(4, 4, &[(8, false)], (4, 4), false);
        assert!(prepare(&cs, &info(4, 4, 3, 8, 8, 0, Photometric::Rgb)).is_err());
        let cs = header(4, 4, &[(12, false)], (4, 4), false);
        assert!(prepare(&cs, &info(4, 4, 1, 8, 8, 0, Photometric::Monochrome2)).is_err());
        assert!(prepare(&cs, &info(4, 4, 1, 16, 12, 0, Photometric::Monochrome2)).is_ok());
        let cs = header(4, 4, &[(8, false), (8, false), (7, false)], (4, 4), false);
        assert!(prepare(&cs, &info(4, 4, 3, 8, 8, 0, Photometric::Rgb)).is_err());
    }

    #[test]
    fn refuses_too_many_tiles() {
        let cs = header(1024, 1024, &[(8, false)], (1, 1), false);
        assert!(read_main_header(&cs).is_err());
        let cs = header(255, 257, &[(8, false)], (1, 1), false);
        assert!(read_main_header(&cs).is_ok());
    }

    #[test]
    fn truncated_headers_are_invalid() {
        let cs = header(4, 4, &[(8, false)], (4, 4), false);
        // Everything before the SOT marker is needed; SOT itself ends the main header.
        for n in 0..cs.len() - 10 {
            assert!(read_main_header(&cs[..n]).is_err(), "prefix {n}");
        }
    }

    #[test]
    fn unwraps_jp2() {
        let cs = header(2, 2, &[(8, false)], (2, 2), false);
        let mut jp2 = JP2_SIGNATURE.to_vec();
        jp2.extend_from_slice(&[0, 0, 0, 20, b'f', b't', b'y', b'p', b'j', b'p', b'2', b' ', 0, 0, 0, 0, b'j', b'p', b'2', b' ']);
        jp2.extend_from_slice(&((8 + cs.len()) as u32).to_be_bytes());
        jp2.extend_from_slice(b"jp2c");
        jp2.extend_from_slice(&cs);
        jp2.push(0); // DICOM pad byte
        let got = unwrap_jp2(&jp2).unwrap();
        assert_eq!(&got[..cs.len()], &cs[..]);
        assert_eq!(got.len(), cs.len() + 1);
        assert_eq!(unwrap_jp2(&cs).unwrap(), &cs[..]);
        assert!(unwrap_jp2(&JP2_SIGNATURE).is_err());
    }

    #[test]
    fn pack_sign_rules() {
        // Unsigned 13-bit codestream, signed data set: sign-extend from bit 12.
        let cs = header(2, 1, &[(13, false)], (2, 1), false);
        let i = info(1, 2, 1, 16, 16, 1, Photometric::Monochrome2);
        let p = prepare(&cs, &i).unwrap();
        let f = pack(&i, &p, |_, k, _| [6192, 100][k]).unwrap();
        assert_eq!(f.data, [(-2000i16).to_le_bytes(), 100i16.to_le_bytes()].concat());
        // Signed 12-bit codestream, unsigned data set: keep the low 12 bits.
        let cs = header(2, 1, &[(12, true)], (2, 1), false);
        let i = info(1, 2, 1, 16, 16, 0, Photometric::Monochrome2);
        let p = prepare(&cs, &i).unwrap();
        let f = pack(&i, &p, |_, k, _| [-1, 5][k]).unwrap();
        assert_eq!(f.data, [0x0FFFu16.to_le_bytes(), 5u16.to_le_bytes()].concat());
        // Matching signedness: as decoded, clamped to the SIZ range.
        let cs = header(2, 1, &[(12, true)], (2, 1), false);
        let i = info(1, 2, 1, 16, 12, 1, Photometric::Monochrome2);
        let p = prepare(&cs, &i).unwrap();
        let f = pack(&i, &p, |_, k, _| [-5000, 7][k]).unwrap();
        assert_eq!(f.data, [(-2048i16).to_le_bytes(), 7i16.to_le_bytes()].concat());
    }

    #[test]
    fn sycc_422_matches_openjpeg() {
        let mut cs = header(3, 1, &[(8, false); 3], (3, 1), false);
        // Make components 1 and 2 subsampled 2x1 (bytes after Ssiz: XRsiz, YRsiz).
        cs[4 + 38 + 3 + 1] = 2;
        cs[4 + 38 + 6 + 1] = 2;
        let i = info(1, 3, 3, 8, 8, 0, Photometric::YbrFull422);
        let p = prepare(&cs, &i).unwrap();
        assert_eq!(p.sycc(), Some((2, 1)));
        assert_eq!(p.component_size(1), (2, 1));
        // Y = 100, 150, 200; (Cb, Cr) = (100, 200) for pixels 0-1 and (128, 128) for pixel 2.
        let f = pack(&i, &p, |c, x, _| match c {
            0 => [100, 150, 200][x],
            1 => [100, 128][x],
            _ => [200, 128][x],
        })
        .unwrap();
        // r = y + trunc(1.402*72) = y+100; g = y - trunc(0.344*-28 + 0.714*72) = y-41;
        // b = y + trunc(1.772*-28) = y-49.
        assert_eq!(f.data, [200, 59, 51, 250, 109, 101, 200, 200, 200]);
        assert_eq!(f.color, ColorOut::Rgb);
        // 4:4:0 or subsampled monochrome are not accepted.
        let mut cs = header(3, 2, &[(8, false); 3], (3, 2), false);
        cs[4 + 38 + 3 + 2] = 2;
        cs[4 + 38 + 6 + 2] = 2;
        let i = info(2, 3, 3, 8, 8, 0, Photometric::YbrFull422);
        assert!(matches!(prepare(&cs, &i), Err(DecodeError::Unsupported(_))));
    }

    #[test]
    fn pack_rgb_interleaves() {
        let cs = header(2, 1, &[(8, false); 3], (2, 1), true);
        let i = info(1, 2, 3, 8, 8, 0, Photometric::YbrRct);
        let p = prepare(&cs, &i).unwrap();
        let f = pack(&i, &p, |c, k, _| (10 * k + c) as i32).unwrap();
        assert_eq!(f.data, [0, 1, 2, 10, 11, 12]);
        assert_eq!(f.color, ColorOut::Rgb);
    }

    #[test]
    fn colour_rule() {
        let colour = |mct: bool, ph: Photometric| {
            let cs = header(1, 1, &[(8, false); 3], (1, 1), mct);
            let i = info(1, 1, 3, 8, 8, 0, ph);
            pack(&i, &prepare(&cs, &i).unwrap(), |_, _, _| 0).unwrap().color
        };
        assert_eq!(colour(true, Photometric::YbrRct), ColorOut::Rgb);
        assert_eq!(colour(true, Photometric::YbrFull), ColorOut::Rgb);
        // No MCT: samples as decoded, whatever the label (coordinator ruling)...
        assert_eq!(colour(false, Photometric::YbrIct), ColorOut::Rgb);
        assert_eq!(colour(false, Photometric::Rgb), ColorOut::Rgb);
        // ...except YBR_FULL, which PS3.5 8.2.4 allows without MCT; the CLI converts it.
        assert_eq!(colour(false, Photometric::YbrFull), ColorOut::AsDeclared);
    }
}

