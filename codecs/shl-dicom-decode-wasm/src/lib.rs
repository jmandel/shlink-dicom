//! [`shl_dicom_decode::decode_file`] for the browser (viewer-kit/).
//!
//! Adds what a viewer needs on top of the canonical pixels:
//!
//! - **Image metadata** ([`read_extra`]): Rescale Slope/Intercept, the first Window Center/Width,
//!   VOI LUT Function, and the same values from the Shared and Per-Frame Functional Groups of
//!   enhanced multi-frame objects.
//! - **Frame ranges** ([`decode_frames`]): decode frames `first..first + count` of a multi-frame
//!   instance without decoding the others, so frames of one instance can be decoded in parallel
//!   by several wasm instances. For encapsulated syntaxes the selected frame codestreams are
//!   re-wrapped in a minimal single-purpose Part 10 file (same transfer syntax and Image Pixel
//!   attributes, one fragment per frame) and passed to `decode_file`, so every frame still goes
//!   through the decoder's own normalisation (planar, Bits Stored, J2K precision, YBR->RGB).
//!   Native (uncompressed) data is decoded whole and the range is sliced out: it is a copy, and
//!   not worth parallelising.
//!
//! The DICOM reader and the frame splitter are the decoder's own `parse.rs` and `encaps.rs`,
//! compiled into this crate by path (they are private modules of `shl-dicom-decode`), so the
//! frame split is exactly the one `decode_file` uses.
//!
//! On wasm32 the crate exports a small C ABI (`vk_*`, see the `exports` module); no wasm-bindgen.

use std::borrow::Cow;
use std::fmt::Write as _;

#[path = "../../shl-dicom-decode/src/parse.rs"]
#[allow(dead_code, clippy::all)]
mod parse;
#[path = "../../shl-dicom-decode/src/encaps.rs"]
#[allow(dead_code, clippy::all)]
mod encaps;

pub use shl_dicom_decode::{decode_file, decode_file_scaled, Canonical, Error};

use parse::{PixelValue, Syntax, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_IMPLICIT_LE};

// --------------------------------------------------------------------------------- metadata

/// Values a viewer needs that `decode_file` does not return. All optional.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Extra {
    pub rescale_slope: Option<f64>,
    pub rescale_intercept: Option<f64>,
    pub window_center: Option<f64>,
    pub window_width: Option<f64>,
    pub voi_lut_function: Option<String>,
    pub modality: Option<String>,
    pub sop_instance_uid: Option<String>,
    pub instance_number: Option<i64>,
    /// From the Per-Frame Functional Groups Sequence (5200,9230), one entry per item.
    pub per_frame: Vec<FrameValues>,
    /// PALETTE COLOR lookup table as RGBA8, with its First Mapped value. None when the instance
    /// has no (non-segmented) Red/Green/Blue Palette Color LUT.
    pub palette: Option<Palette>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Palette {
    pub first: i32,
    /// count × 4 bytes.
    pub rgba: Vec<u8>,
}

/// Raw palette descriptor (0028,110x) and data (0028,120x) values, R/G/B.
#[derive(Default)]
struct RawPalette<'a> {
    desc: [Option<&'a [u8]>; 3],
    data: [Option<&'a [u8]>; 3],
}

/// Build an RGBA8 LUT as pydicom's `apply_color_lut` reads the tables (PS3.3 C.7.6.3.1.5):
/// descriptor = (entries, 0 meaning 65536; first mapped value; bits per entry). 16-bit entries
/// are scaled to 8 bits by taking the high byte; 8-bit tables stored in 16-bit words are read as
/// words.
fn build_palette(raw: &RawPalette<'_>, little: bool, signed: bool) -> Option<Palette> {
    let mut first = 0i32;
    let mut count = 0usize;
    let mut chans: Vec<Vec<u8>> = Vec::with_capacity(3);
    for k in 0..3 {
        let d = raw.desc[k]?;
        let data = raw.data[k]?;
        let n = parse::read_u16(d.get(0..2)?, little)?;
        let f = parse::read_u16(d.get(2..4)?, little)?;
        let bits = parse::read_u16(d.get(4..6)?, little)?;
        let n = if n == 0 { 65536 } else { usize::from(n) };
        let f = if signed { i32::from(f as i16) } else { i32::from(f) };
        if k == 0 {
            first = f;
            count = n;
        } else if n != count {
            return None;
        }
        let vals: Vec<u8> = if data.len() >= 2 * n {
            data.chunks_exact(2)
                .take(n)
                .map(|c| {
                    let v = parse::read_u16(c, little).unwrap_or(0);
                    if bits == 8 { v.min(255) as u8 } else { (v >> 8) as u8 }
                })
                .collect()
        } else if data.len() >= n {
            data[..n].to_vec()
        } else {
            return None;
        };
        chans.push(vals);
    }
    let mut rgba = Vec::with_capacity(count * 4);
    for ((r, g), b) in chans[0].iter().zip(&chans[1]).zip(&chans[2]) {
        rgba.extend_from_slice(&[*r, *g, *b, 255]);
    }
    Some(Palette { first, rgba })
}

/// Rescale and window values from one functional-groups item.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FrameValues {
    pub rescale_slope: Option<f64>,
    pub rescale_intercept: Option<f64>,
    pub window_center: Option<f64>,
    pub window_width: Option<f64>,
}

impl FrameValues {
    fn set(&mut self, element: u16, v: &[u8]) {
        let slot = match element {
            0x1050 => &mut self.window_center,
            0x1051 => &mut self.window_width,
            0x1052 => &mut self.rescale_intercept,
            0x1053 => &mut self.rescale_slope,
            _ => return,
        };
        if slot.is_none() {
            *slot = first_number(v);
        }
    }
    fn or(self, o: FrameValues) -> FrameValues {
        FrameValues {
            rescale_slope: self.rescale_slope.or(o.rescale_slope),
            rescale_intercept: self.rescale_intercept.or(o.rescale_intercept),
            window_center: self.window_center.or(o.window_center),
            window_width: self.window_width.or(o.window_width),
        }
    }
}

/// First value of a DS/IS string ("40\400" -> 40).
fn first_number(v: &[u8]) -> Option<f64> {
    let s = parse::trim_text(v);
    let first = s.split('\\').next()?.trim();
    first.parse::<f64>().ok().filter(|x| x.is_finite())
}

const UNDEFINED: u32 = 0xFFFF_FFFF;
const MAX_DEPTH: u32 = 16;

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// Top-level data set.
    Top,
    /// Inside an item of the Shared Functional Groups Sequence.
    Shared,
    /// Inside item `n` of the Per-Frame Functional Groups Sequence.
    PerFrame(usize),
    /// Somewhere nothing is recorded.
    Ignore,
}

struct Walker<'a> {
    b: &'a [u8],
    little: bool,
    extra: Extra,
    shared: FrameValues,
    palette: RawPalette<'a>,
    pixel_representation: u16,
}

impl<'a> Walker<'a> {
    fn u16(&self, p: usize) -> Option<u16> {
        parse::read_u16(self.b.get(p..p + 2)?, self.little)
    }
    fn u32(&self, p: usize) -> Option<u32> {
        parse::read_u32(self.b.get(p..p + 4)?, self.little)
    }

    /// Walk elements in `pos..end` (end = None: until an item delimiter or the end of data).
    /// Returns the position after the last element read (after the item delimiter, if any).
    fn elements(&mut self, mut pos: usize, end: usize, explicit: bool, ctx: Ctx, depth: u32) -> Option<usize> {
        if depth > MAX_DEPTH {
            return None;
        }
        while pos + 8 <= end {
            let group = self.u16(pos)?;
            let element = self.u16(pos + 2)?;
            if group == 0xFFFE {
                // Item delimiter (E00D) ends an undefined-length item.
                return Some(pos + 8);
            }
            if ctx == Ctx::Top && group == 0x7FE0 {
                return Some(pos); // Pixel Data: everything needed comes before it.
            }
            let vr = self.b.get(pos + 4..pos + 6)?;
            // Undefined-length items may switch to implicit VR (pydicom does the same check).
            let is_explicit = explicit && vr.iter().all(u8::is_ascii_uppercase);
            let (len, hdr, is_sq, is_un) = if is_explicit {
                let long = matches!(
                    vr,
                    b"OB" | b"OD" | b"OF" | b"OL" | b"OV" | b"OW" | b"SQ" | b"SV" | b"UC" | b"UN" | b"UR" | b"UT" | b"UV"
                );
                if long {
                    (self.u32(pos + 8)?, 12, vr == b"SQ", vr == b"UN")
                } else {
                    (u32::from(self.u16(pos + 6)?), 8, false, false)
                }
            } else {
                (self.u32(pos + 4)?, 8, false, false)
            };
            let vstart = pos + hdr;
            let tag = (u32::from(group) << 16) | u32::from(element);
            let known_sq = matches!(tag, 0x5200_9229 | 0x5200_9230 | 0x0028_9145 | 0x0028_9132);
            if len == UNDEFINED || is_sq || known_sq {
                let child_ctx = match (ctx, tag) {
                    (Ctx::Top, 0x5200_9229) => Ctx::Shared,
                    (Ctx::Top, 0x5200_9230) => Ctx::PerFrame(0),
                    (Ctx::Shared | Ctx::PerFrame(_), _) => ctx, // functional group macros
                    _ => Ctx::Ignore,
                };
                // Undefined-length UN holds implicit VR little endian.
                let child_explicit = explicit && !is_un;
                let seq_end = if len == UNDEFINED { self.b.len() } else { vstart.checked_add(len as usize)?.min(self.b.len()) };
                pos = self.items(vstart, seq_end, len == UNDEFINED, child_explicit, child_ctx, depth + 1)?;
                continue;
            }
            let vend = vstart.checked_add(len as usize)?;
            let v = self.b.get(vstart..vend)?;
            self.record(ctx, group, element, v);
            pos = vend;
        }
        Some(pos)
    }

    /// Items of a sequence starting at `pos`. Returns the position after the sequence.
    fn items(&mut self, mut pos: usize, end: usize, undefined: bool, explicit: bool, ctx: Ctx, depth: u32) -> Option<usize> {
        let mut index = 0usize;
        while pos + 8 <= end {
            let group = self.u16(pos)?;
            let element = self.u16(pos + 2)?;
            let len = self.u32(pos + 4)?;
            pos += 8;
            if group != 0xFFFE {
                return None;
            }
            match element {
                0xE0DD => return Some(pos), // sequence delimiter
                0xE000 => {
                    let item_ctx = match ctx {
                        Ctx::PerFrame(_) => Ctx::PerFrame(index),
                        c => c,
                    };
                    if len == UNDEFINED {
                        pos = self.elements(pos, end, explicit, item_ctx, depth)?;
                    } else {
                        let iend = pos.checked_add(len as usize)?;
                        if iend > end {
                            return None;
                        }
                        self.elements(pos, iend, explicit, item_ctx, depth)?;
                        pos = iend;
                    }
                    index += 1;
                }
                _ => pos = pos.checked_add(if len == UNDEFINED { 0 } else { len as usize })?,
            }
        }
        if undefined {
            None
        } else {
            Some(end)
        }
    }

    fn record(&mut self, ctx: Ctx, group: u16, element: u16, v: &'a [u8]) {
        match ctx {
            Ctx::Top => {
                let e = &mut self.extra;
                match (group, element) {
                    (0x0008, 0x0018) => e.sop_instance_uid = Some(parse::trim_text(v)),
                    (0x0008, 0x0060) => e.modality = Some(parse::trim_text(v)),
                    (0x0020, 0x0013) => e.instance_number = first_number(v).map(|x| x as i64),
                    (0x0028, 0x1050) => e.window_center = first_number(v),
                    (0x0028, 0x1051) => e.window_width = first_number(v),
                    (0x0028, 0x1052) => e.rescale_intercept = first_number(v),
                    (0x0028, 0x1053) => e.rescale_slope = first_number(v),
                    (0x0028, 0x1056) => e.voi_lut_function = Some(parse::trim_text(v)),
                    (0x0028, 0x0103) => self.pixel_representation = parse::read_u16(v, self.little).unwrap_or(0),
                    (0x0028, 0x1101..=0x1103) => self.palette.desc[usize::from(element - 0x1101)] = Some(v),
                    (0x0028, 0x1201..=0x1203) => self.palette.data[usize::from(element - 0x1201)] = Some(v),
                    _ => {}
                }
            }
            Ctx::Shared if group == 0x0028 => self.shared.set(element, v),
            Ctx::PerFrame(i) if group == 0x0028 && matches!(element, 0x1050..=0x1053) && i < 1 << 16 => {
                if self.extra.per_frame.len() <= i {
                    self.extra.per_frame.resize(i + 1, FrameValues::default());
                }
                if let Some(f) = self.extra.per_frame.get_mut(i) {
                    f.set(element, v);
                }
            }
            _ => {}
        }
    }
}

/// Read [`Extra`] from a DICOM file. Never fails: values it cannot read are `None`.
///
/// Top-level values win. Otherwise the first value from the Per-Frame Functional Groups item 0,
/// then the Shared Functional Groups, is reported as the image-level value; `per_frame` keeps
/// every per-frame item, with shared values filled in where the item has none.
pub fn read_extra(bytes: &[u8]) -> Extra {
    let Ok(prepared) = parse::prepare(bytes) else { return Extra::default() };
    let ds: &[u8] = &prepared.dataset;
    let Syntax { explicit, little } = prepared.syntax;
    let mut w = Walker {
        b: ds,
        little,
        extra: Extra::default(),
        shared: FrameValues::default(),
        palette: RawPalette::default(),
        pixel_representation: 0,
    };
    let _ = w.elements(0, ds.len(), explicit, Ctx::Top, 0);
    let shared = w.shared;
    let palette = build_palette(&w.palette, little, w.pixel_representation == 1);
    let mut e = w.extra;
    e.palette = palette;
    for f in &mut e.per_frame {
        *f = f.or(shared);
    }
    let fg = e.per_frame.first().copied().unwrap_or_default().or(shared);
    e.rescale_slope = e.rescale_slope.or(fg.rescale_slope);
    e.rescale_intercept = e.rescale_intercept.or(fg.rescale_intercept);
    if e.window_center.is_none() || e.window_width.is_none() {
        e.window_center = fg.window_center;
        e.window_width = fg.window_width;
    }
    e
}

// ------------------------------------------------------------------------------ frame ranges

/// Number of Frames as `decode_file` reads it (missing, empty or 0 -> 1; first value of a
/// multi-valued IS).
fn number_of_frames(raw: Option<&[u8]>) -> Result<usize, Error> {
    let Some(raw) = raw else { return Ok(1) };
    let s = parse::trim_text(raw);
    if s.is_empty() {
        return Ok(1);
    }
    let first = s.split('\\').next().unwrap_or("").trim();
    let n: i64 = first.parse().map_err(|_| Error::Invalid(format!("Number of Frames {s:?}")))?;
    match n {
        0 => Ok(1),
        n if n < 0 => Err(Error::Invalid(format!("Number of Frames {n}"))),
        n => usize::try_from(n).map_err(|_| Error::Invalid(format!("Number of Frames {n}"))),
    }
}

/// What the decoder needs to know before decoding: how many frames, and whether frames can be
/// decoded separately (encapsulated) or only as a whole (native).
#[derive(Debug, Clone)]
pub struct Probe {
    pub transfer_syntax: String,
    pub frames: usize,
    pub encapsulated: bool,
}

pub fn probe(bytes: &[u8]) -> Result<Probe, Error> {
    let prepared = parse::prepare(bytes)?;
    let attrs = parse::read_dataset(&prepared.dataset, prepared.syntax)?;
    let ts = prepared.transfer_syntax.clone().unwrap_or_else(|| TS_IMPLICIT_LE.to_string());
    Ok(Probe {
        frames: number_of_frames(attrs.number_of_frames)?,
        encapsulated: !is_native(&ts) && matches!(attrs.pixel, Some(PixelValue::Encapsulated { .. })),
        transfer_syntax: ts,
    })
}

fn is_native(ts: &str) -> bool {
    matches!(ts, TS_IMPLICIT_LE | TS_EXPLICIT_LE | TS_EXPLICIT_BE | TS_DEFLATED_LE)
}

/// Decode frames `first..first + count` (count 0: all frames from `first`). Returns the canonical
/// pixels of those frames only (`frames` = number returned) and the instance's total frame count.
///
/// The pixels are byte-identical to the same frames of `decode_file(bytes)`.
pub fn decode_frames(bytes: &[u8], first: usize, count: usize) -> Result<(Canonical, usize), Error> {
    decode_frames_scaled(bytes, first, count, 0)
}

/// [`decode_frames`] at 1/2^`scale` size: `shl_dicom_decode::decode_file_scaled` on the selected
/// frames (CONTRACT.md, "Reduced-resolution decode"). The result is ceil(rows / 2^scale) ×
/// ceil(columns / 2^scale), byte-identical to the same frames of `decode_file_scaled(bytes,
/// scale)`. `scale` 0 is [`decode_frames`].
pub fn decode_frames_scaled(bytes: &[u8], first: usize, count: usize, scale: u8) -> Result<(Canonical, usize), Error> {
    let decode = |b: &[u8]| if scale == 0 { decode_file(b) } else { decode_file_scaled(b, scale) };
    let prepared = parse::prepare(bytes)?;
    let attrs = parse::read_dataset(&prepared.dataset, prepared.syntax)?;
    let total = number_of_frames(attrs.number_of_frames)?;
    let count = if count == 0 { total.saturating_sub(first) } else { count };
    if first == 0 && count >= total {
        return decode(bytes).map(|c| (c, total));
    }
    let end = first.checked_add(count).filter(|&e| e <= total && count > 0).ok_or_else(|| {
        Error::Invalid(format!("frames {first}..{} requested, the instance has {total}", first + count))
    })?;
    let ts = prepared.transfer_syntax.clone().unwrap_or_else(|| TS_IMPLICIT_LE.to_string());

    if is_native(&ts) || shl_dicom_decode::codec_for(&ts).is_none() {
        // Native: decode whole and slice. No codec: decode_file reports the same error.
        let mut c = decode(bytes)?;
        let fb = c.data.len() / (c.frames.max(1) as usize);
        let start = fb * first;
        c.data = c.data.get(start..fb * end).map(<[u8]>::to_vec).unwrap_or_default();
        c.frames = count as u32;
        return Ok((c, total));
    }

    let little = ts != TS_EXPLICIT_BE;
    let reparsed;
    let (basic_offsets, fragments) = match attrs.pixel.as_ref() {
        Some(PixelValue::Encapsulated { basic_offsets, fragments, .. }) => (*basic_offsets, fragments),
        Some(PixelValue::Native { data, .. }) => {
            reparsed = parse::parse_items(data, little)?;
            match &reparsed {
                PixelValue::Encapsulated { basic_offsets, fragments, .. } => (*basic_offsets, fragments),
                PixelValue::Native { .. } => return Err(Error::Invalid("Pixel Data is not encapsulated".into())),
            }
        }
        // Let decode_file produce its own error for anything unusual.
        None => return decode(bytes).map(|c| (c, total)),
    };
    let extended = attrs.extended_offsets.zip(attrs.extended_lengths);
    let frames = encaps::split_frames(basic_offsets, fragments, extended, total, little)?;
    let selected = frames.get(first..end).unwrap_or(&[]);
    let file = rewrap(&ts, &attrs, selected);
    let mut c = decode(&file)?;
    c.transfer_syntax = ts;
    Ok((c, total))
}

/// A minimal Part 10 file holding `frames` as one fragment each, with the source's Image Pixel
/// attributes copied byte for byte (encapsulated data sets are little endian).
fn rewrap(ts: &str, a: &parse::Attributes<'_>, frames: &[Cow<'_, [u8]>]) -> Vec<u8> {
    let payload: usize = frames.iter().map(|f| f.len() + 9).sum();
    let mut out = Vec::with_capacity(payload + 512);
    out.extend_from_slice(&[0u8; 128]);
    out.extend_from_slice(b"DICM");
    let mut ts_v = ts.as_bytes().to_vec();
    if ts_v.len() % 2 == 1 {
        ts_v.push(0);
    }
    short(&mut out, 0x0002, 0x0010, b"UI", &ts_v);
    let nf = frames.len().to_string();
    type Attr<'x> = (u16, &'x [u8; 2], Option<&'x [u8]>);
    let attrs: [Attr<'_>; 9] = [
        (0x0002, b"US", a.samples_per_pixel),
        (0x0004, b"CS", a.photometric),
        (0x0006, b"US", a.planar_configuration),
        (0x0008, b"IS", Some(nf.as_bytes())),
        (0x0010, b"US", a.rows),
        (0x0011, b"US", a.columns),
        (0x0100, b"US", a.bits_allocated),
        (0x0101, b"US", a.bits_stored),
        (0x0103, b"US", a.pixel_representation),
    ];
    for (element, vr, v) in attrs {
        if let Some(v) = v {
            let mut v = v.to_vec();
            if v.len() % 2 == 1 {
                v.push(b' ');
            }
            short(&mut out, 0x0028, element, vr, &v);
        }
    }
    out.extend_from_slice(&[0xE0, 0x7F, 0x10, 0x00, b'O', b'B', 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
    item(&mut out, &[]);
    for f in frames {
        item(&mut out, f);
    }
    out.extend_from_slice(&[0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
    out
}

fn short(out: &mut Vec<u8>, group: u16, element: u16, vr: &[u8; 2], v: &[u8]) {
    out.extend_from_slice(&group.to_le_bytes());
    out.extend_from_slice(&element.to_le_bytes());
    out.extend_from_slice(vr);
    out.extend_from_slice(&(v.len().min(0xFFFF) as u16).to_le_bytes());
    out.extend_from_slice(&v[..v.len().min(0xFFFF)]);
}

fn item(out: &mut Vec<u8>, v: &[u8]) {
    let padded = v.len() + v.len() % 2;
    out.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
    out.extend_from_slice(&(padded as u32).to_le_bytes());
    out.extend_from_slice(v);
    if v.len() % 2 == 1 {
        out.push(0);
    }
}

// --------------------------------------------------------------------------- result as JSON

/// Smallest and largest sample (single-sample images only; colour returns None).
pub fn min_max(c: &Canonical) -> Option<(f64, f64)> {
    if c.samples_per_pixel != 1 || c.data.is_empty() {
        return None;
    }
    macro_rules! scan {
        ($t:ty, $n:expr) => {{
            let mut lo = <$t>::MAX;
            let mut hi = <$t>::MIN;
            for ch in c.data.chunks_exact($n) {
                let mut b = [0u8; $n];
                b.copy_from_slice(ch);
                let v = <$t>::from_le_bytes(b);
                lo = lo.min(v);
                hi = hi.max(v);
            }
            Some((lo as f64, hi as f64))
        }};
    }
    match (c.bytes_per_sample(), c.signed) {
        (1, false) => scan!(u8, 1),
        (1, true) => scan!(i8, 1),
        (2, false) => scan!(u16, 2),
        (2, true) => scan!(i16, 2),
        (4, false) => scan!(u32, 4),
        (4, true) => scan!(i32, 4),
        _ => None,
    }
}

fn jstr(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn jnum(out: &mut String, v: Option<f64>) {
    match v {
        Some(x) if x.is_finite() => {
            let _ = write!(out, "{x}");
        }
        _ => out.push_str("null"),
    }
}

fn jopt_str(out: &mut String, v: Option<&str>) {
    match v {
        Some(s) => jstr(out, s),
        None => out.push_str("null"),
    }
}

/// Rows and Columns as the data set declares them (the full size), or None if unreadable.
pub fn full_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let prepared = parse::prepare(bytes).ok()?;
    let attrs = parse::read_dataset(&prepared.dataset, prepared.syntax).ok()?;
    let little = prepared.transfer_syntax.as_deref() != Some(TS_EXPLICIT_BE);
    let rows = parse::read_u16(attrs.rows?, little)?;
    let columns = parse::read_u16(attrs.columns?, little)?;
    Some((u32::from(rows), u32::from(columns)))
}

/// [`info_json`] for a reduced-resolution result: the same object (whose `rows`, `columns` and
/// `frameBytes` describe the reduced pixels) plus `"scale"` (log2 of the reduction) and
/// `"fullRows"` / `"fullColumns"` (the instance's own size).
pub fn info_json_scaled(c: &Canonical, first: usize, total: usize, e: &Extra, scale: u8, full: (u32, u32)) -> String {
    let mut o = info_json(c, first, total, e);
    o.pop(); // the closing brace
    let _ = write!(o, ",\"scale\":{scale},\"fullRows\":{},\"fullColumns\":{}}}", full.0, full.1);
    o
}

/// Metadata of a decode result as one JSON object (see viewer-kit/src/types.ts `ImageInfo`).
pub fn info_json(c: &Canonical, first: usize, total: usize, e: &Extra) -> String {
    let mut o = String::with_capacity(512);
    let frame_bytes = c.data.len() / (c.frames.max(1) as usize);
    let _ = write!(
        o,
        "{{\"rows\":{},\"columns\":{},\"frames\":{},\"firstFrame\":{first},\"totalFrames\":{total},\"samplesPerPixel\":{},\"bitsAllocated\":{},\"bitsStored\":{},\"pixelRepresentation\":{},\"frameBytes\":{frame_bytes},\"photometric\":",
        c.rows, c.columns, c.frames, c.samples_per_pixel, c.bits_allocated, c.bits_stored, u8::from(c.signed)
    );
    jstr(&mut o, &c.photometric);
    o.push_str(",\"transferSyntax\":");
    jstr(&mut o, &c.transfer_syntax);
    o.push_str(",\"rescaleSlope\":");
    jnum(&mut o, Some(e.rescale_slope.unwrap_or(1.0)));
    o.push_str(",\"rescaleIntercept\":");
    jnum(&mut o, Some(e.rescale_intercept.unwrap_or(0.0)));
    o.push_str(",\"windowCenter\":");
    jnum(&mut o, e.window_center);
    o.push_str(",\"windowWidth\":");
    jnum(&mut o, e.window_width);
    o.push_str(",\"voiLutFunction\":");
    jopt_str(&mut o, e.voi_lut_function.as_deref());
    o.push_str(",\"modality\":");
    jopt_str(&mut o, e.modality.as_deref());
    o.push_str(",\"sopInstanceUid\":");
    jopt_str(&mut o, e.sop_instance_uid.as_deref());
    o.push_str(",\"instanceNumber\":");
    jnum(&mut o, e.instance_number.map(|n| n as f64));
    let mm = min_max(c);
    o.push_str(",\"minValue\":");
    jnum(&mut o, mm.map(|m| m.0));
    o.push_str(",\"maxValue\":");
    jnum(&mut o, mm.map(|m| m.1));
    o.push_str(",\"perFrame\":");
    let pf = e.per_frame.get(first..(first + c.frames as usize).min(e.per_frame.len()));
    match pf {
        Some(list) if !list.is_empty() => {
            o.push('[');
            for (i, f) in list.iter().enumerate() {
                if i > 0 {
                    o.push(',');
                }
                o.push_str("{\"rescaleSlope\":");
                jnum(&mut o, f.rescale_slope);
                o.push_str(",\"rescaleIntercept\":");
                jnum(&mut o, f.rescale_intercept);
                o.push_str(",\"windowCenter\":");
                jnum(&mut o, f.window_center);
                o.push_str(",\"windowWidth\":");
                jnum(&mut o, f.window_width);
                o.push('}');
            }
            o.push(']');
        }
        _ => o.push_str("null"),
    }
    o.push_str(",\"palette\":");
    match &e.palette {
        Some(p) => {
            let _ = write!(o, "{{\"first\":{},\"count\":{}}}", p.first, p.rgba.len() / 4);
        }
        None => o.push_str("null"),
    }
    o.push('}');
    o
}

#[cfg(target_arch = "wasm32")]
mod exports {
    //! C ABI for viewer-kit/src/decoder-worker.ts. One result is held at a time per instance.
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static JSON: RefCell<String> = const { RefCell::new(String::new()) };
        static MSG: RefCell<String> = const { RefCell::new(String::new()) };
        static LUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    #[no_mangle]
    pub extern "C" fn vk_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr`/`len` must come from `vk_alloc(len)`.
    #[no_mangle]
    pub unsafe extern "C" fn vk_free(ptr: *mut u8, len: usize) {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }

    fn fail(e: &Error) -> i32 {
        let msg = match e {
            Error::Invalid(m) | Error::Unsupported(m) => m.clone(),
        };
        MSG.with(|m| *m.borrow_mut() = msg);
        e.exit_code()
    }

    /// Decode frames `first..first + count` (count 0: all) of the file at ptr/len. Returns 0
    /// (pixels at vk_out_ptr/len, metadata JSON at vk_json_ptr/len) or the CONTRACT exit code
    /// 2 or 3 (message at vk_msg_ptr/len). The input stays owned by the caller.
    ///
    /// # Safety
    /// `ptr`/`len` must be a live allocation from `vk_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn vk_decode(ptr: *const u8, len: usize, first: u32, count: u32) -> i32 {
        OUT.with(|o| *o.borrow_mut() = Vec::new());
        let bytes = std::slice::from_raw_parts(ptr, len);
        match decode_frames(bytes, first as usize, count as usize) {
            Ok((c, total)) => {
                let mut extra = read_extra(bytes);
                JSON.with(|j| *j.borrow_mut() = info_json(&c, first as usize, total, &extra));
                LUT.with(|l| *l.borrow_mut() = extra.palette.take().map(|p| p.rgba).unwrap_or_default());
                OUT.with(|o| *o.borrow_mut() = c.data);
                0
            }
            Err(e) => fail(&e),
        }
    }

    /// [`vk_decode`] at 1/2^`scale` size (`decode_frames_scaled`). The JSON adds `scale`,
    /// `fullRows` and `fullColumns`; its `rows`, `columns` and `frameBytes` describe the reduced
    /// pixels. `scale` 0 gives the same pixels as `vk_decode`.
    ///
    /// # Safety
    /// `ptr`/`len` must be a live allocation from `vk_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn vk_decode_scaled(ptr: *const u8, len: usize, first: u32, count: u32, scale: u32) -> i32 {
        OUT.with(|o| *o.borrow_mut() = Vec::new());
        let bytes = std::slice::from_raw_parts(ptr, len);
        let s = scale.min(16) as u8;
        match decode_frames_scaled(bytes, first as usize, count as usize, s) {
            Ok((c, total)) => {
                let mut extra = read_extra(bytes);
                let full = full_size(bytes).unwrap_or((c.rows, c.columns));
                JSON.with(|j| *j.borrow_mut() = info_json_scaled(&c, first as usize, total, &extra, s, full));
                LUT.with(|l| *l.borrow_mut() = extra.palette.take().map(|p| p.rgba).unwrap_or_default());
                OUT.with(|o| *o.borrow_mut() = c.data);
                0
            }
            Err(e) => fail(&e),
        }
    }

    /// Frame count and whether frames decode separately: JSON
    /// `{"frames":N,"encapsulated":bool,"transferSyntax":"..."}` at vk_json_ptr/len.
    ///
    /// # Safety
    /// `ptr`/`len` must be a live allocation from `vk_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn vk_probe(ptr: *const u8, len: usize) -> i32 {
        let bytes = std::slice::from_raw_parts(ptr, len);
        match probe(bytes) {
            Ok(p) => {
                let mut o = String::new();
                let _ = write!(o, "{{\"frames\":{},\"encapsulated\":{},\"transferSyntax\":", p.frames, p.encapsulated);
                jstr(&mut o, &p.transfer_syntax);
                o.push('}');
                JSON.with(|j| *j.borrow_mut() = o);
                0
            }
            Err(e) => fail(&e),
        }
    }

    #[no_mangle]
    pub extern "C" fn vk_out_ptr() -> *const u8 {
        OUT.with(|o| o.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn vk_out_len() -> usize {
        OUT.with(|o| o.borrow().len())
    }
    #[no_mangle]
    pub extern "C" fn vk_out_free() {
        OUT.with(|o| *o.borrow_mut() = Vec::new());
    }
    /// RGBA8 palette of the last decode (empty when none); see `palette` in the JSON.
    #[no_mangle]
    pub extern "C" fn vk_lut_ptr() -> *const u8 {
        LUT.with(|l| l.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn vk_lut_len() -> usize {
        LUT.with(|l| l.borrow().len())
    }
    #[no_mangle]
    pub extern "C" fn vk_json_ptr() -> *const u8 {
        JSON.with(|j| j.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn vk_json_len() -> usize {
        JSON.with(|j| j.borrow().len())
    }
    #[no_mangle]
    pub extern "C" fn vk_msg_ptr() -> *const u8 {
        MSG.with(|m| m.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn vk_msg_len() -> usize {
        MSG.with(|m| m.borrow().len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(out: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8]) {
        short(out, g, e, vr, v);
    }

    #[test]
    fn reads_top_level_and_functional_groups() {
        let mut ds = Vec::new();
        el(&mut ds, 0x0008, 0x0060, b"CS", b"CT");
        el(&mut ds, 0x0028, 0x1052, b"DS", b"-1024 ");
        // Shared FG: Frame VOI LUT seq with WC/WW, undefined lengths.
        let mut inner = Vec::new();
        el(&mut inner, 0x0028, 0x1050, b"DS", b"40\\50 ");
        el(&mut inner, 0x0028, 0x1051, b"DS", b"400 ");
        let mut voi = vec![0x28, 0x00, 0x32, 0x91, b'S', b'Q', 0, 0, 0xFF, 0xFF, 0xFF, 0xFF];
        voi.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0, 0xFF, 0xFF, 0xFF, 0xFF]);
        voi.extend_from_slice(&inner);
        voi.extend_from_slice(&[0xFE, 0xFF, 0x0D, 0xE0, 0, 0, 0, 0, 0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
        ds.extend_from_slice(&[0x00, 0x52, 0x29, 0x92, b'S', b'Q', 0, 0]);
        let item_len = voi.len() as u32;
        ds.extend_from_slice(&(item_len + 8).to_le_bytes());
        ds.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
        ds.extend_from_slice(&item_len.to_le_bytes());
        ds.extend_from_slice(&voi);
        let mut file = vec![0u8; 128];
        file.extend_from_slice(b"DICM");
        short(&mut file, 0x0002, 0x0010, b"UI", b"1.2.840.10008.1.2.1\0");
        file.extend_from_slice(&ds);
        let e = read_extra(&file);
        assert_eq!(e.modality.as_deref(), Some("CT"));
        assert_eq!(e.rescale_intercept, Some(-1024.0));
        assert_eq!(e.window_center, Some(40.0));
        assert_eq!(e.window_width, Some(400.0));
    }
}
