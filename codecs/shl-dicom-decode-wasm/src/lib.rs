//! [`shl_dicom_decode::decode_file`] for the browser (viewer-kit/).
//!
//! Adds what a viewer needs on top of the canonical pixels:
//!
//! - **Image metadata** ([`read_extra`]): Rescale Slope/Intercept, the first Window Center/Width,
//!   VOI LUT Function, and the same values from the Shared and Per-Frame Functional Groups of
//!   enhanced multi-frame objects.
//! - **Real World Value Mapping** (first item, from the top level or the functional groups): the
//!   slope, intercept, label and units that map stored values (float parametric maps included)
//!   to measured quantities.
//! - **Frame ranges** ([`decode_frames`]): decode frames `first..first + count` of a multi-frame
//!   instance without decoding the others (`shl_dicom_decode::decode_frames`), so frames of one
//!   instance can be decoded in parallel by several wasm instances.
//!
//! The DICOM reader is the decoder's own `parse.rs`, compiled into this crate by path (it is a
//! private module of `shl-dicom-decode`).
//!
//! On wasm32 the crate exports a small C ABI (`vk_*`, see the `exports` module); no wasm-bindgen.

use std::fmt::Write as _;

// parse.rs names the transfer syntax table as `crate::syntax`.
use shl_dicom_decode::syntax;

#[path = "../../shl-dicom-decode/src/parse.rs"]
#[allow(dead_code, unused_imports, clippy::all)]
mod parse;

pub use shl_dicom_decode::{decode_file, decode_file_scaled, Canonical, Error};

use parse::{PixelValue, TS_EXPLICIT_BE, TS_IMPLICIT_LE};

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
    /// First item of the Real World Value Mapping Sequence (0040,9096), from Per-Frame Functional
    /// Groups item 0, else the Shared Functional Groups, else the top level.
    pub real_world: Option<RealWorld>,
}

/// One Real World Value Mapping item: value = stored × slope + intercept, in `units`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RealWorld {
    pub slope: Option<f64>,
    pub intercept: Option<f64>,
    /// LUT Label (0040,9210).
    pub label: Option<String>,
    /// Measurement Units Code Sequence (0040,08EA): Code Value (UCUM) and Code Meaning.
    pub units: Option<String>,
    pub units_meaning: Option<String>,
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

/// Build the Palette Color Lookup Table as RGBA8, for display. The descriptor (PS3.3 C.7.6.3.1.5)
/// is (number of entries, 0 meaning 65536; first stored pixel value mapped, signed when Pixel
/// Representation is 1; bits per entry, 8 or 16). The data (C.7.6.3.1.6) hold one entry per
/// stored value from the first mapped one; a 16-bit entry's full range 0–65535 is the output
/// range, so it becomes round(v × 255 / 65535) (v / 257, exact at both ends). 8-bit entries are
/// read one per byte, or one per 16-bit word when the data are that long (older writers padded
/// them so).
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
                    if bits == 8 { v.min(255) as u8 } else { ((u32::from(v) + 128) / 257) as u8 }
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
    /// The window only when it has both a centre and a width (a centre alone is not a window).
    fn whole_window(self) -> FrameValues {
        if self.window_center.is_some() && self.window_width.is_some() {
            self
        } else {
            FrameValues { window_center: None, window_width: None, ..self }
        }
    }
    /// Each value from `self`, else from `o`; the window (centre and width) as a pair.
    fn or(self, o: FrameValues) -> FrameValues {
        let own_window = self.window_center.is_some() && self.window_width.is_some();
        let (window_center, window_width) = if own_window || o.window_center.is_none() || o.window_width.is_none() {
            (self.window_center.or(o.window_center), self.window_width.or(o.window_width))
        } else {
            (o.window_center, o.window_width)
        };
        FrameValues {
            rescale_slope: self.rescale_slope.or(o.rescale_slope),
            rescale_intercept: self.rescale_intercept.or(o.rescale_intercept),
            window_center,
            window_width,
        }
    }
}

/// First value of a DS/IS string ("40\400" -> 40).
fn first_number(v: &[u8]) -> Option<f64> {
    let s = parse::trim_text(v);
    let first = s.split('\\').next()?.trim();
    first.parse::<f64>().ok().filter(|x| x.is_finite())
}


#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// Top-level data set.
    Top,
    /// Inside an item of the Shared Functional Groups Sequence.
    Shared,
    /// The Per-Frame Functional Groups Sequence itself: its items are numbered, one per frame.
    PerFrameItems,
    /// Inside item `n` of the Per-Frame Functional Groups Sequence (and in the functional group
    /// sequences nested in it, which keep `n`).
    PerFrame(usize),
    /// Inside the first Real World Value Mapping item (`units`: in its Measurement Units Code
    /// Sequence). `rank` orders the places one can be found: 0 top level, 1 shared, 2 per-frame.
    RealWorld { rank: u8, units: bool },
    /// Somewhere nothing is recorded.
    Ignore,
}

struct Walker<'a> {
    little: bool,
    extra: Extra,
    shared: FrameValues,
    palette: RawPalette<'a>,
    pixel_representation: u16,
    /// The Real World Value Mapping item found so far, and the rank of where it was found.
    real_world: Option<(u8, RealWorld)>,
    /// The context of the data set or item being read (top level first).
    ctx: Vec<Ctx>,
    /// The context of each sequence entered, for its items.
    seqs: Vec<Ctx>,
}

/// Sequences read as such when their length is defined and implicit VR gives no VR: the
/// functional group, VOI LUT, pixel value transformation and Real World Value Mapping ones.
fn known_sequence(tag: u32) -> bool {
    matches!(tag, 0x5200_9229 | 0x5200_9230 | 0x0028_9145 | 0x0028_9132 | 0x0040_9096 | 0x0040_08EA)
}

impl<'a> parse::Visitor<'a> for Walker<'a> {
    fn element(&mut self, e: &parse::Element<'a>) -> parse::Step {
        let ctx = *self.ctx.last().unwrap_or(&Ctx::Top);
        if e.depth == 0 && e.tag >> 16 == 0x7FE0 {
            return parse::Step::Stop; // Pixel Data: everything needed comes before it.
        }
        let Some(v) = e.value else {
            let child = match (ctx, e.tag) {
                (Ctx::Top, 0x5200_9229) => Ctx::Shared,
                (Ctx::Top, 0x5200_9230) => Ctx::PerFrameItems,
                // Rank: Per-Frame, then Shared Functional Groups, then the top level (decision (b)).
                (Ctx::PerFrame(_), 0x0040_9096) => Ctx::RealWorld { rank: 0, units: false },
                (Ctx::Shared, 0x0040_9096) => Ctx::RealWorld { rank: 1, units: false },
                (Ctx::Top, 0x0040_9096) => Ctx::RealWorld { rank: 2, units: false },
                (Ctx::RealWorld { rank, .. }, 0x0040_08EA) => Ctx::RealWorld { rank, units: true },
                (Ctx::Shared | Ctx::PerFrame(_), _) => ctx, // functional group macros
                _ => Ctx::Ignore,
            };
            if child == Ctx::Ignore {
                return parse::Step::Skip;
            }
            self.seqs.push(child);
            return parse::Step::Next;
        };
        self.record(ctx, (e.tag >> 16) as u16, e.tag as u16, v);
        parse::Step::Next
    }
    fn item(&mut self, index: usize, _depth: u32) {
        let item = match *self.seqs.last().unwrap_or(&Ctx::Ignore) {
            Ctx::PerFrameItems => Ctx::PerFrame(index),
            // Only the first item of a Real World Value Mapping Sequence is read.
            Ctx::RealWorld { .. } if index > 0 => Ctx::Ignore,
            c => c,
        };
        self.ctx.push(item);
    }
    fn item_end(&mut self, _depth: u32) {
        self.ctx.pop();
    }
    fn sequence_end(&mut self, _depth: u32) {
        self.seqs.pop();
    }
}

impl<'a> Walker<'a> {
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
            Ctx::RealWorld { rank, units } => self.record_real_world(rank, units, group, element, v),
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

impl Walker<'_> {
    fn record_real_world(&mut self, rank: u8, units: bool, group: u16, element: u16, v: &[u8]) {
        // Keep the item from the best-ranked place; a later item from a worse place is ignored.
        match &self.real_world {
            Some((r, _)) if *r < rank => return,
            Some((r, _)) if *r > rank => self.real_world = None,
            _ => {}
        }
        let little = self.little;
        let fd = |v: &[u8]| parse::read_u64(v, little).map(f64::from_bits).filter(|x| x.is_finite());
        let rw = &mut self.real_world.get_or_insert_with(|| (rank, RealWorld::default())).1;
        match (units, group, element) {
            (false, 0x0040, 0x9224) => rw.intercept = rw.intercept.or(fd(v)),
            (false, 0x0040, 0x9225) => rw.slope = rw.slope.or(fd(v)),
            (false, 0x0040, 0x9210) => rw.label = rw.label.take().or(Some(parse::trim_text(v))),
            (true, 0x0008, 0x0100) => rw.units = rw.units.take().or(Some(parse::trim_text(v))),
            (true, 0x0008, 0x0104) => rw.units_meaning = rw.units_meaning.take().or(Some(parse::trim_text(v))),
            _ => {}
        }
    }
}

/// Read [`Extra`] from a DICOM file. Never fails: values it cannot read are `None`.
///
/// A functional group value wins over the top-level one, as in an enhanced multi-frame instance the
/// functional groups describe the frames: the image-level value is the Per-Frame Functional Groups
/// item 0's, else the Shared Functional Groups', else the top level's. `per_frame` keeps every
/// per-frame item, filled in the same order (shared, then top level) where the item has none.
pub fn read_extra(bytes: &[u8]) -> Extra {
    let Ok(prepared) = parse::prepare(bytes) else { return Extra::default() };
    let ds: &[u8] = &prepared.dataset;
    let little = prepared.syntax.little;
    let mut w = Walker {
        little,
        extra: Extra::default(),
        shared: FrameValues::default(),
        palette: RawPalette::default(),
        pixel_representation: 0,
        real_world: None,
        ctx: vec![Ctx::Top],
        seqs: Vec::new(),
    };
    // Values read before an error are kept: read_extra never fails.
    let _ = parse::walk(ds, prepared.syntax, &known_sequence, &mut w);
    let shared = w.shared;
    let palette = build_palette(&w.palette, little, w.pixel_representation == 1);
    let real_world = w.real_world.take().map(|(_, rw)| rw);
    let mut e = w.extra;
    e.palette = palette;
    e.real_world = real_world;
    let top = FrameValues {
        rescale_slope: e.rescale_slope,
        rescale_intercept: e.rescale_intercept,
        window_center: e.window_center,
        window_width: e.window_width,
    };
    for f in &mut e.per_frame {
        *f = f.or(shared).or(top).whole_window();
    }
    // The image-level values are frame 1's.
    let image = e.per_frame.first().copied().unwrap_or(shared.or(top).whole_window());
    e.rescale_slope = image.rescale_slope;
    e.rescale_intercept = image.rescale_intercept;
    e.window_center = image.window_center;
    e.window_width = image.window_width;
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
        encapsulated: !shl_dicom_decode::is_native(&ts) && matches!(attrs.pixel, Some(PixelValue::Encapsulated { .. })),
        transfer_syntax: ts,
    })
}

/// Decode frames `first..first + count` (count 0, or a count running past the last frame: every
/// frame from `first`). Returns the canonical pixels of those frames only (`frames` = number
/// returned) and the instance's total frame count. The pixels are byte-identical to the same
/// frames of `decode_file(bytes)`.
pub fn decode_frames(bytes: &[u8], first: usize, count: usize) -> Result<(Canonical, usize), Error> {
    decode_frames_scaled(bytes, first, count, 0)
}

/// [`decode_frames`] at 1/2^`scale` size (CONTRACT.md, "Reduced-resolution decode"): ceil(rows /
/// 2^scale) × ceil(columns / 2^scale), byte-identical to the same frames of
/// `decode_file_scaled(bytes, scale)`. `scale` 0 is [`decode_frames`].
pub fn decode_frames_scaled(bytes: &[u8], first: usize, count: usize, scale: u8) -> Result<(Canonical, usize), Error> {
    let total = probe(bytes).map(|p| p.frames).unwrap_or(0);
    let count = if first < total && count >= total - first { 0 } else { count };
    let c = shl_dicom_decode::decode_frames(bytes, first, count, scale)?;
    let total = c.total_frames as usize;
    Ok((c, total))
}

// --------------------------------------------------------------------------- result as JSON

/// Smallest and largest sample (single-sample images only; colour returns None). Float samples
/// that are NaN or infinite are left out; None if no sample is finite.
pub fn min_max(c: &Canonical) -> Option<(f64, f64)> {
    if c.samples_per_pixel != 1 || c.data.is_empty() {
        return None;
    }
    if c.float {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut scan = |v: f64| {
            if v.is_finite() {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        };
        match c.bytes_per_sample() {
            4 => c.data.chunks_exact(4).for_each(|b| scan(f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])))),
            8 => c.data.chunks_exact(8).for_each(|b| scan(f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))),
            _ => return None,
        }
        return (lo <= hi).then_some((lo, hi));
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
        "{{\"rows\":{},\"columns\":{},\"frames\":{},\"firstFrame\":{first},\"totalFrames\":{total},\"samplesPerPixel\":{},\"bitsAllocated\":{},\"bitsStored\":{},\"pixelRepresentation\":{},\"float\":{},\"frameBytes\":{frame_bytes},\"photometric\":",
        c.rows, c.columns, c.frames, c.samples_per_pixel, c.bits_allocated, c.bits_stored, u8::from(c.signed), c.float
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
    o.push_str(",\"realWorldValueMapping\":");
    match &e.real_world {
        Some(rw) => {
            o.push_str("{\"slope\":");
            jnum(&mut o, rw.slope);
            o.push_str(",\"intercept\":");
            jnum(&mut o, rw.intercept);
            o.push_str(",\"label\":");
            jopt_str(&mut o, rw.label.as_deref());
            o.push_str(",\"units\":");
            jopt_str(&mut o, rw.units.as_deref());
            o.push_str(",\"unitsMeaning\":");
            jopt_str(&mut o, rw.units_meaning.as_deref());
            o.push('}');
        }
        None => o.push_str("null"),
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
#[path = "../../shl-dicom-decode/tests/support/ds.rs"]
mod ds;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ds::{part10, Ds, Enc};

    const LE: Enc = Enc::ExplicitLe;
    const EXPLICIT_LE: &str = "1.2.840.10008.1.2.1";

    #[test]
    fn reads_top_level_and_functional_groups() {
        let mut ds = Ds::new(LE);
        ds.text(0x0008, 0x0060, b"CS", "CT");
        ds.text(0x0028, 0x1052, b"DS", "-1024");
        // Shared FG: Frame VOI LUT seq with WC/WW, undefined lengths.
        let voi = |i: &mut Ds| {
            i.text(0x0028, 0x1050, b"DS", "40\\50").text(0x0028, 0x1051, b"DS", "400");
        };
        let mut shared = Ds::new(LE);
        shared.seq(0x0028, 0x9132, &[&voi]);
        ds.seq_defined(0x5200, 0x9229, &[&shared.out]);
        let e = read_extra(&part10(EXPLICIT_LE, &ds.out, true));
        assert_eq!(e.modality.as_deref(), Some("CT"));
        assert_eq!(e.rescale_intercept, Some(-1024.0));
        assert_eq!(e.window_center, Some(40.0));
        assert_eq!(e.window_width, Some(400.0));
    }

    #[test]
    fn reads_real_world_value_mapping_from_shared_groups() {
        // Shared FG item > RWVM item (slope 2.5, intercept -1, label, units code "mm2/s").
        let mut units = Ds::new(LE);
        units.text(0x0008, 0x0100, b"SH", "mm2/s").text(0x0008, 0x0104, b"LO", "mm2/s");
        let mut rw = Ds::new(LE);
        rw.seq_defined(0x0040, 0x08EA, &[&units.out]);
        rw.text(0x0040, 0x9210, b"SH", "ADC");
        for (tag, x) in [(0x9224u16, -1.0f64), (0x9225, 2.5)] {
            rw.elem(0x0040, tag, b"FD", &x.to_le_bytes());
        }
        let mut shared = Ds::new(LE);
        shared.seq_defined(0x0040, 0x9096, &[&rw.out]);
        let mut ds = Ds::new(LE);
        ds.seq_defined(0x5200, 0x9229, &[&shared.out]);
        let e = read_extra(&part10(EXPLICIT_LE, &ds.out, true));
        let rw = e.real_world.expect("mapping");
        assert_eq!((rw.slope, rw.intercept), (Some(2.5), Some(-1.0)));
        assert_eq!(rw.label.as_deref(), Some("ADC"));
        assert_eq!(rw.units.as_deref(), Some("mm2/s"));
    }

    /// One Per-Frame Functional Groups item: a Frame VOI LUT Sequence (centre, and width when
    /// given) and a Pixel Value Transformation Sequence (intercept and slope, when given).
    fn frame_item(window: Option<(&str, Option<&str>)>, rescale: (Option<&str>, Option<&str>)) -> Vec<u8> {
        let mut item = Ds::new(LE);
        if let Some((c, w)) = window {
            let mut voi = Ds::new(LE);
            voi.text(0x0028, 0x1050, b"DS", c);
            if let Some(w) = w {
                voi.text(0x0028, 0x1051, b"DS", w);
            }
            item.seq_defined(0x0028, 0x9132, &[&voi.out]);
        }
        if rescale.0.is_some() || rescale.1.is_some() {
            let mut pvt = Ds::new(LE);
            if let Some(i) = rescale.0 {
                pvt.text(0x0028, 0x1052, b"DS", i);
            }
            if let Some(sl) = rescale.1 {
                pvt.text(0x0028, 0x1053, b"DS", sl);
            }
            item.seq_defined(0x0028, 0x9145, &[&pvt.out]);
        }
        item.out
    }

    #[test]
    fn per_frame_values_stay_with_their_frame() {
        // Legacy Converted Enhanced PET shape: each Per-Frame Functional Groups item holds a
        // Pixel Value Transformation Sequence and a Frame VOI LUT Sequence (nested sequences).
        let items: Vec<Vec<u8>> = [("0", "2", "100"), ("1", "3", "200"), ("2", "4.5", "300")]
            .iter()
            .map(|(i, sl, c)| frame_item(Some((c, Some("50"))), (Some(i), Some(sl))))
            .collect();
        let mut ds = Ds::new(LE);
        ds.seq_defined(0x5200, 0x9230, &items.iter().map(|v| v.as_slice()).collect::<Vec<_>>());
        let e = read_extra(&part10(EXPLICIT_LE, &ds.out, true));
        assert_eq!(e.per_frame.len(), 3);
        let got: Vec<(Option<f64>, Option<f64>, Option<f64>)> =
            e.per_frame.iter().map(|f| (f.rescale_slope, f.rescale_intercept, f.window_center)).collect();
        assert_eq!(got, [(Some(2.0), Some(0.0), Some(100.0)), (Some(3.0), Some(1.0), Some(200.0)), (Some(4.5), Some(2.0), Some(300.0))]);
        // The image-level values are frame 1's.
        assert_eq!((e.rescale_slope, e.window_center), (Some(2.0), Some(100.0)));
    }

    /// read_extra reads with the decoder's walker (parse::walk): a stray item at the top level
    /// (fo-dicom #364) is read past, as the decoder does, so the values after it are found.
    #[test]
    fn values_after_a_stray_top_level_item_are_read() {
        let mut ds = Ds::new(LE);
        ds.text(0x0008, 0x0060, b"CS", "US");
        ds.raw(&[0xFE, 0xFF, 0x00, 0xE0, 4, 0, 0, 0, 1, 2, 3, 4]);
        ds.text(0x0028, 0x1050, b"DS", "127").text(0x0028, 0x1051, b"DS", "254");
        let e = read_extra(&part10(EXPLICIT_LE, &ds.out, true));
        assert_eq!((e.window_center, e.window_width), (Some(127.0), Some(254.0)));
    }

    #[test]
    fn functional_groups_win_over_the_top_level() {
        // Item 0 has a slope and a whole window; item 1 a window centre only.
        let items = [frame_item(Some(("100", Some("50"))), (None, Some("2"))), frame_item(Some(("300", None)), (None, None))];
        let mut ds = Ds::new(LE);
        ds.text(0x0028, 0x1050, b"DS", "10").text(0x0028, 0x1051, b"DS", "20");
        ds.text(0x0028, 0x1052, b"DS", "-5").text(0x0028, 0x1053, b"DS", "7");
        ds.seq_defined(0x5200, 0x9230, &[&items[0], &items[1]]);
        let e = read_extra(&part10(EXPLICIT_LE, &ds.out, true));
        let got: Vec<_> = e.per_frame.iter().map(|f| (f.rescale_slope, f.rescale_intercept, f.window_center, f.window_width)).collect();
        // Item 1's lone centre does not make a window with the top level's width.
        assert_eq!(got, [(Some(2.0), Some(-5.0), Some(100.0), Some(50.0)), (Some(7.0), Some(-5.0), Some(10.0), Some(20.0))]);
        assert_eq!((e.rescale_slope, e.rescale_intercept, e.window_center, e.window_width), (Some(2.0), Some(-5.0), Some(100.0), Some(50.0)));
        // A centre without a width is no window.
        let mut lone = Ds::new(LE);
        lone.text(0x0028, 0x1050, b"DS", "128");
        let e = read_extra(&part10(EXPLICIT_LE, &lone.out, true));
        assert_eq!((e.window_center, e.window_width), (None, None));
    }
}
