//! Minimal DICOM reader: finds the file meta, the transfer syntax, the Image Pixel attributes of the
//! top-level data set and the Pixel Data element. It works on an in-memory slice, checks every
//! length against the bytes actually present, and never allocates from a declared length.
//!
//! The reading rules follow pydicom (`dcmread(force=True)`), which produces the oracle:
//! - a 128-byte preamble + `DICM` is optional; a file may start directly with the group 0002
//!   file meta, or with a bare data set (no meta at all);
//! - without a Transfer Syntax UID, the encoding is guessed from the first element;
//! - an undefined-length sequence item may switch from explicit to implicit VR (detected from its
//!   first element), as pydicom does; a top-level data set whose encoding contradicts the transfer
//!   syntax is refused (pydicom's pixel path and dcmtk refuse it too);
//! - reading stops after the top-level Pixel Data element.

use std::borrow::Cow;

use crate::Error;

const UNDEFINED: u32 = 0xFFFF_FFFF;
const MAX_DEPTH: u32 = 64;
/// Upper bound for an inflated Deflated Explicit VR Little Endian data set.
const MAX_INFLATED: usize = 1 << 31;

pub use crate::syntax::{
    DEFLATED_LE as TS_DEFLATED_LE, EXPLICIT_BE as TS_EXPLICIT_BE, EXPLICIT_LE as TS_EXPLICIT_LE, GE_PRIVATE as TS_GE_PRIVATE,
    IMPLICIT_LE as TS_IMPLICIT_LE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Syntax {
    pub explicit: bool,
    pub little: bool,
}

const IMPLICIT_LE: Syntax = Syntax { explicit: false, little: true };
const EXPLICIT_LE: Syntax = Syntax { explicit: true, little: true };
const EXPLICIT_BE: Syntax = Syntax { explicit: true, little: false };

/// The Pixel Data element as found in the file.
#[derive(Debug)]
pub enum PixelValue<'a> {
    /// Defined-length (native) pixel data, bytes in file order.
    Native { data: &'a [u8], vr: Option<[u8; 2]> },
    /// Undefined-length (encapsulated) pixel data.
    Encapsulated {
        basic_offsets: &'a [u8],
        fragments: Vec<Fragment<'a>>,
        /// Set when a damaged ending was tolerated (see `read_encapsulated`).
        note: Option<String>,
    },
}

/// One encapsulated fragment and the offset of its item tag, counted from the first byte of the
/// first item after the Basic Offset Table (the origin of both offset tables).
#[derive(Debug, Clone, Copy)]
pub struct Fragment<'a> {
    pub offset: u64,
    pub data: &'a [u8],
}

/// Raw values of the top-level elements the decoder needs.
#[derive(Debug, Default)]
pub struct Attributes<'a> {
    /// Red, Green, Blue Palette Color Lookup Table Descriptors (0028,1101–1103) and Data
    /// (0028,1201–1203).
    pub palette_descriptors: [Option<&'a [u8]>; 3],
    pub palette_data: [Option<&'a [u8]>; 3],
    /// ACR-NEMA Recognition Code (0008,0010), retired.
    pub recognition_code: Option<&'a [u8]>,
    pub samples_per_pixel: Option<&'a [u8]>,
    pub photometric: Option<&'a [u8]>,
    pub planar_configuration: Option<&'a [u8]>,
    pub number_of_frames: Option<&'a [u8]>,
    pub rows: Option<&'a [u8]>,
    pub columns: Option<&'a [u8]>,
    pub bits_allocated: Option<&'a [u8]>,
    pub bits_stored: Option<&'a [u8]>,
    pub pixel_representation: Option<&'a [u8]>,
    pub extended_offsets: Option<&'a [u8]>,
    pub extended_lengths: Option<&'a [u8]>,
    /// Float Pixel Data (7FE0,0008) or Double Float Pixel Data (7FE0,0009): the value, and the
    /// sample size in bits (32 or 64).
    pub float_pixel: Option<(&'a [u8], u16)>,
    pub pixel: Option<PixelValue<'a>>,
}

/// File meta and the encoded data set, inflated if necessary.
pub struct Prepared<'a> {
    /// Transfer Syntax UID from the file meta (trimmed), or None for a bare data set.
    pub transfer_syntax: Option<String>,
    /// How the data set bytes are encoded.
    pub syntax: Syntax,
    pub dataset: Cow<'a, [u8]>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(n).ok_or_else(|| invalid("length overflow"))?;
        let s = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| invalid(format!("truncated: needed {n} bytes at offset {}, {} left", self.pos, self.remaining())))?;
        self.pos = end;
        Ok(s)
    }

    fn peek(&self, n: usize) -> Option<&'a [u8]> {
        self.buf.get(self.pos..self.pos.checked_add(n)?)
    }

    fn u16(&mut self, little: bool) -> Result<u16, Error> {
        let b = self.take(2)?;
        Ok(read_u16(b, little).unwrap_or(0))
    }

    fn u32(&mut self, little: bool) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(read_u32(b, little).unwrap_or(0))
    }
}

pub fn read_u16(b: &[u8], little: bool) -> Option<u16> {
    let a: [u8; 2] = b.get(..2)?.try_into().ok()?;
    Some(if little { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) })
}

pub fn read_u32(b: &[u8], little: bool) -> Option<u32> {
    let a: [u8; 4] = b.get(..4)?.try_into().ok()?;
    Some(if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
}

pub fn read_u64(b: &[u8], little: bool) -> Option<u64> {
    let a: [u8; 8] = b.get(..8)?.try_into().ok()?;
    Some(if little { u64::from_le_bytes(a) } else { u64::from_be_bytes(a) })
}

fn looks_like_vr(b: &[u8]) -> bool {
    // pydicom's test: both bytes in 'A'..='Z'.
    matches!(b, [x, y] if x.is_ascii_uppercase() && y.is_ascii_uppercase())
}

/// VRs pydicom recognises when guessing the encoding of a bare data set.
const KNOWN_VRS: &[&[u8; 2]] = &[
    b"AE", b"AS", b"AT", b"CS", b"DA", b"DS", b"DT", b"FD", b"FL", b"IS", b"LO", b"LT", b"OB", b"OD", b"OF",
    b"OL", b"OV", b"OW", b"PN", b"SH", b"SL", b"SQ", b"SS", b"ST", b"SV", b"TM", b"UC", b"UI", b"UL", b"UN",
    b"UR", b"US", b"UT", b"UV",
];

fn has_long_length(vr: &[u8; 2]) -> bool {
    matches!(
        vr,
        b"OB" | b"OD" | b"OF" | b"OL" | b"OV" | b"OW" | b"SQ" | b"SV" | b"UC" | b"UN" | b"UR" | b"UT" | b"UV"
    )
}

#[derive(Debug, Clone, Copy)]
struct Header {
    group: u16,
    element: u16,
    vr: Option<[u8; 2]>,
    len: u32,
}

impl Header {
    fn tag(&self) -> u32 {
        (u32::from(self.group) << 16) | u32::from(self.element)
    }
}

fn read_header(c: &mut Cursor<'_>, s: Syntax) -> Result<Header, Error> {
    let group = c.u16(s.little)?;
    let element = c.u16(s.little)?;
    if group == 0xFFFE {
        let len = c.u32(s.little)?;
        return Ok(Header { group, element, vr: None, len });
    }
    if !s.explicit {
        let len = c.u32(s.little)?;
        return Ok(Header { group, element, vr: None, len });
    }
    let raw = c.take(2)?;
    let vr: [u8; 2] = [raw.first().copied().unwrap_or(0), raw.get(1).copied().unwrap_or(0)];
    if !(b"AA".as_slice()..=b"ZZ".as_slice()).contains(&vr.as_slice()) {
        // One element written in implicit VR inside an explicit VR data set (a known writer bug,
        // e.g. GDCM 1.2.0). pydicom (`assume_implicit_vr_switch`) and GDCM re-read that element
        // as implicit: the two "VR" bytes are the low half of a 4-byte length.
        c.pos = c.pos.saturating_sub(2);
        let len = c.u32(s.little)?;
        return Ok(Header { group, element, vr: None, len });
    }
    // Inside AA..ZZ but not a known long-length VR: pydicom reads a 2-byte length.
    let len = if has_long_length(&vr) {
        c.take(2)?;
        c.u32(s.little)?
    } else {
        u32::from(c.u16(s.little)?)
    };
    Ok(Header { group, element, vr: Some(vr), len })
}

/// pydicom's check for a data set (or item) that is really implicit VR although explicit was
/// expected (or the reverse, for the top level): look at the two bytes where the VR would be.
fn detect_vr_mode(c: &Cursor<'_>, assumed: Syntax, top_level: bool) -> Syntax {
    let Some(head) = c.peek(6) else { return assumed };
    // Delimiters carry no VR.
    if read_u16(head, assumed.little) == Some(0xFFFE) {
        return assumed;
    }
    let found_implicit = !looks_like_vr(head.get(4..6).unwrap_or(&[]));
    if !top_level && !assumed.explicit {
        return assumed; // items of an implicit data set stay implicit
    }
    if found_implicit == !assumed.explicit {
        return assumed;
    }
    if !top_level && !found_implicit {
        return assumed; // items never switch from implicit to explicit
    }
    Syntax { explicit: !found_implicit, little: assumed.little }
}

/// Split the input into file meta and data set, inflating a deflated data set.
pub fn prepare(bytes: &[u8]) -> Result<Prepared<'_>, Error> {
    let meta_start = if bytes.get(128..132) == Some(b"DICM") {
        Some(132)
    } else if bytes.get(..4) == Some(b"DICM") {
        Some(4)
    } else if bytes.get(..2) == Some(&[0x02, 0x00]) {
        Some(0)
    } else {
        None
    };

    let (transfer_syntax, ds_start) = match meta_start {
        Some(start) => read_meta(bytes, start)?,
        None => (None, 0),
    };
    let rest = bytes.get(ds_start..).unwrap_or(&[]);

    match transfer_syntax.as_deref() {
        None => Ok(Prepared { transfer_syntax, syntax: guess_syntax(rest), dataset: Cow::Borrowed(rest) }),
        Some(TS_IMPLICIT_LE | TS_GE_PRIVATE) => {
            Ok(Prepared { transfer_syntax, syntax: IMPLICIT_LE, dataset: Cow::Borrowed(rest) })
        }
        Some(TS_EXPLICIT_BE) => Ok(Prepared { transfer_syntax, syntax: EXPLICIT_BE, dataset: Cow::Borrowed(rest) }),
        Some(TS_DEFLATED_LE) => {
            let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(rest, MAX_INFLATED)
                .map_err(|e| invalid(format!("deflated data set does not inflate: {:?}", e.status)))?;
            Ok(Prepared { transfer_syntax, syntax: EXPLICIT_LE, dataset: Cow::Owned(inflated) })
        }
        // Explicit VR Little Endian and every encapsulated syntax.
        Some(_) => Ok(Prepared { transfer_syntax, syntax: EXPLICIT_LE, dataset: Cow::Borrowed(rest) }),
    }
}

/// pydicom's guess for a data set with no Transfer Syntax UID (issue 258 in pydicom).
fn guess_syntax(ds: &[u8]) -> Syntax {
    let Some(head) = ds.get(..6) else { return IMPLICIT_LE };
    let group = read_u16(head, true).unwrap_or(0);
    let vr = head.get(4..6).unwrap_or(&[]);
    if KNOWN_VRS.iter().any(|k| k.as_slice() == vr) {
        if group >= 1024 {
            EXPLICIT_BE
        } else {
            EXPLICIT_LE
        }
    } else {
        IMPLICIT_LE
    }
}

/// Read group 0002 starting at `start`. Returns the Transfer Syntax UID and where the data set starts.
///
/// The meta header ends at the first element that is not in group 0002 or whose tag does not
/// increase. A second copy of group 0002 after it (fo-dicom #1376) belongs to the data set, which
/// may not contain group 0002 (PS3.10 7.1); it is skipped there, as dcmtk skips it.
fn read_meta(bytes: &[u8], start: usize) -> Result<(Option<String>, usize), Error> {
    let mut c = Cursor::new(bytes);
    c.pos = start;
    let mut ts = None;
    let mut last_element: Option<u16> = None;
    while let Some(head) = c.peek(6) {
        if read_u16(head, true) != Some(0x0002) {
            break;
        }
        let element = read_u16(head.get(2..4).unwrap_or(&[]), true).unwrap_or(0);
        if last_element.is_some_and(|last| element <= last) {
            break;
        }
        last_element = Some(element);
        // The meta is explicit VR little endian; tolerate an implicit one as pydicom does.
        let syntax = if looks_like_vr(head.get(4..6).unwrap_or(&[])) { EXPLICIT_LE } else { IMPLICIT_LE };
        let h = read_header(&mut c, syntax)?;
        if h.len == UNDEFINED {
            return Err(invalid(format!("undefined length in file meta at ({:04X},{:04X})", h.group, h.element)));
        }
        let v = c.take(h.len as usize)?;
        if h.element == 0x0010 {
            ts = Some(trim_text(v));
        }
    }
    Ok((ts.filter(|s| !s.is_empty()), c.pos))
}

/// Text value with trailing/leading spaces and NULs removed.
pub fn trim_text(v: &[u8]) -> String {
    String::from_utf8_lossy(v).trim_matches(|ch: char| ch == '\0' || ch.is_whitespace()).to_string()
}

/// Read the top-level data set up to and including Pixel Data.
pub fn read_dataset(ds: &[u8], assumed: Syntax) -> Result<Attributes<'_>, Error> {
    let mut c = Cursor::new(ds);
    let s = detect_vr_mode(&c, assumed, true);
    if s != assumed {
        // pydicom's dcmread switches and warns, but its pixel path and dcmtk both refuse such
        // files (e.g. pydicom's SC_rgb_jpeg.dcm), so this is treated as malformed.
        return Err(invalid(format!(
            "data set is {} VR but the transfer syntax says {} VR",
            if s.explicit { "explicit" } else { "implicit" },
            if assumed.explicit { "explicit" } else { "implicit" }
        )));
    }
    struct Collect<'a> {
        a: Attributes<'a>,
        pixel_at: Option<usize>,
    }
    impl<'a> Visitor<'a> for Collect<'a> {
        fn element(&mut self, e: &Element<'a>) -> Step {
            if e.tag == 0x7FE0_0010 {
                match e.value {
                    Some(data) => self.a.pixel = Some(PixelValue::Native { data, vr: e.vr }),
                    None => self.pixel_at = Some(e.pos),
                }
                return Step::Stop;
            }
            let Some(v) = e.value else { return Step::Skip };
            let a = &mut self.a;
            match e.tag {
                0x0008_0010 => a.recognition_code = Some(v),
                0x0028_1101..=0x0028_1103 => a.palette_descriptors[(e.tag - 0x0028_1101) as usize] = Some(v),
                0x0028_1201..=0x0028_1203 => a.palette_data[(e.tag - 0x0028_1201) as usize] = Some(v),
                0x0028_0002 => a.samples_per_pixel = Some(v),
                0x0028_0004 => a.photometric = Some(v),
                0x0028_0006 => a.planar_configuration = Some(v),
                0x0028_0008 => a.number_of_frames = Some(v),
                0x0028_0010 => a.rows = Some(v),
                0x0028_0011 => a.columns = Some(v),
                0x0028_0100 => a.bits_allocated = Some(v),
                0x0028_0101 => a.bits_stored = Some(v),
                0x0028_0103 => a.pixel_representation = Some(v),
                0x7FE0_0001 => a.extended_offsets = Some(v),
                0x7FE0_0002 => a.extended_lengths = Some(v),
                0x7FE0_0008 => a.float_pixel = Some((v, 32)),
                0x7FE0_0009 => a.float_pixel = Some((v, 64)),
                _ => {}
            }
            Step::Next
        }
    }
    // The top level only (sequences are skipped); the walk stops at Pixel Data.
    let mut col = Collect { a: Attributes::default(), pixel_at: None };
    walk(ds, s, &|_| false, &mut col)?;
    let mut a = col.a;
    if let Some(at) = col.pixel_at {
        // Encapsulated Pixel Data: its items, read from its header on.
        c.pos = at;
        read_header(&mut c, s)?;
        a.pixel = Some(read_encapsulated(&mut c, s)?);
    }
    Ok(a)
}

/// Skip the value of an undefined-length element: a sequence (SQ, UN, or anything in implicit VR).
fn skip_undefined(c: &mut Cursor<'_>, s: Syntax, h: &Header, depth: u32) -> Result<(), Error> {
    let items_syntax = match h.vr {
        None | Some([b'S', b'Q']) => s,
        // PS3.5 6.2.2: an undefined-length UN element holds implicit VR little endian items.
        Some([b'U', b'N']) => IMPLICIT_LE,
        // Encapsulated pixel data nested in a sequence (e.g. an icon image) is a sequence of
        // defined-length items, so it skips the same way.
        Some([b'O', b'B']) | Some([b'O', b'W']) if h.tag() == 0x7FE0_0010 => s,
        Some(vr) => {
            return Err(invalid(format!(
                "undefined length on {}{} element ({:04X},{:04X})",
                vr[0] as char, vr[1] as char, h.group, h.element
            )))
        }
    };
    skip_sequence(c, items_syntax, depth.saturating_add(1))
}

fn skip_sequence(c: &mut Cursor<'_>, s: Syntax, depth: u32) -> Result<(), Error> {
    if depth > MAX_DEPTH {
        return Err(invalid("sequences nested too deeply"));
    }
    loop {
        let group = c.u16(s.little)?;
        let element = c.u16(s.little)?;
        let len = c.u32(s.little)?;
        match (group, element) {
            (0xFFFE, 0xE0DD) => return Ok(()),
            (0xFFFE, 0xE000) if len == UNDEFINED => {
                let item_syntax = detect_vr_mode(c, s, false);
                skip_item(c, item_syntax, depth)?;
            }
            (0xFFFE, 0xE000) => {
                c.take(len as usize)?;
            }
            _ => return Err(invalid(format!("expected an item in sequence, found ({group:04X},{element:04X})"))),
        }
    }
}

fn skip_item(c: &mut Cursor<'_>, s: Syntax, depth: u32) -> Result<(), Error> {
    loop {
        let h = read_header(c, s)?;
        if h.group == 0xFFFE {
            if h.element == 0xE00D {
                return Ok(());
            }
            return Err(invalid(format!("unexpected ({:04X},{:04X}) inside an item", h.group, h.element)));
        }
        if h.len == UNDEFINED {
            skip_undefined(c, s, &h, depth)?;
        } else {
            c.take(h.len as usize)?;
        }
    }
}

// ------------------------------------------------------------------------------------- walk

/// One element as [`walk`] meets it.
#[derive(Debug, Clone, Copy)]
pub struct Element<'a> {
    pub tag: u32,
    /// The VR as written (explicit VR), None in implicit VR.
    pub vr: Option<[u8; 2]>,
    /// Where its header starts in the data set.
    pub pos: usize,
    /// Its value (defined length), or None for an undefined length.
    pub value: Option<&'a [u8]>,
    /// Nesting: 0 for the top level, 1 inside an item of a top-level sequence, and so on.
    #[allow(dead_code)] // read by shl-dicom-decode-wasm, which compiles this file too
    pub depth: u32,
}

/// What [`walk`] does after an element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Go on (into the items, when the element is a sequence).
    Next,
    /// Go on, but not into this sequence's items.
    Skip,
    /// Stop the walk here.
    Stop,
}

/// What a [`walk`] reports, in order.
pub trait Visitor<'a> {
    /// Every element. A sequence (SQ, an undefined length, or a tag `is_sequence` names) is entered
    /// unless this returns [`Step::Skip`].
    fn element(&mut self, e: &Element<'a>) -> Step;
    /// An item of the sequence last entered starts (`index` from 0) / ends.
    fn item(&mut self, _index: usize, _depth: u32) {}
    fn item_end(&mut self, _depth: u32) {}
    /// The sequence last entered ends.
    fn sequence_end(&mut self, _depth: u32) {}
}

/// Walks a data set's elements in order, entering sequences, with the rules [`read_dataset`] uses
/// to read and skip them: an undefined-length item may be in implicit VR (detected from its first
/// element, as pydicom does), an undefined-length UN holds implicit VR little endian items (PS3.5
/// 6.2.2), at most 64 levels of nesting, and every length checked against the bytes present.
/// `is_sequence` names tags to read as sequences when their length is defined and no VR says so
/// (implicit VR). Returns where the walk ended (the data set's end, or the element it stopped at).
pub fn walk<'a>(ds: &'a [u8], s: Syntax, is_sequence: &dyn Fn(u32) -> bool, v: &mut dyn Visitor<'a>) -> Result<usize, Error> {
    let mut c = Cursor::new(ds);
    match walk_elements(&mut c, ds.len(), s, is_sequence, v, 0)? {
        Some(at) => Ok(at),
        None => Ok(c.pos),
    }
}

/// Elements up to `end` (or an item delimiter); Some(position) when the visitor stopped.
fn walk_elements<'a>(c: &mut Cursor<'a>, end: usize, s: Syntax, is_sequence: &dyn Fn(u32) -> bool, v: &mut dyn Visitor<'a>, depth: u32) -> Result<Option<usize>, Error> {
    if depth > MAX_DEPTH {
        return Err(invalid("sequences nested too deeply"));
    }
    while c.pos < end {
        let pos = c.pos;
        let h = read_header(c, s)?;
        if h.group == 0xFFFE {
            if depth > 0 {
                if h.element == 0xE00D {
                    return Ok(None); // end of an undefined-length item
                }
                return Err(invalid(format!("unexpected ({:04X},{:04X}) inside an item", h.group, h.element)));
            }
            // A stray item or delimiter tag at the top level (seen in a Philips US file,
            // fo-dicom #364): pydicom reads it as an element of its stated length and goes on.
            if h.len == UNDEFINED {
                return Err(invalid(format!("undefined-length ({:04X},{:04X}) at the top level of the data set", h.group, h.element)));
            }
            c.take(h.len as usize)?;
            continue;
        }
        let tag = h.tag();
        let sequence = h.len == UNDEFINED || h.vr == Some(*b"SQ") || (h.vr.is_none() && is_sequence(tag));
        let value = if h.len == UNDEFINED || sequence { None } else { Some(c.take(h.len as usize)?) };
        let step = v.element(&Element { tag, vr: h.vr, pos, value: if sequence { None } else { value }, depth });
        if step == Step::Stop {
            return Ok(Some(pos));
        }
        if !sequence {
            continue;
        }
        if h.len == UNDEFINED {
            let items = match h.vr {
                None | Some([b'S', b'Q']) => s,
                Some([b'U', b'N']) => IMPLICIT_LE,
                Some([b'O', b'B']) | Some([b'O', b'W']) if tag == 0x7FE0_0010 => s,
                Some(vr) => {
                    return Err(invalid(format!("undefined length on {}{} element ({:04X},{:04X})", vr[0] as char, vr[1] as char, h.group, h.element)))
                }
            };
            if step == Step::Skip || tag == 0x7FE0_0010 {
                skip_sequence(c, items, depth.saturating_add(1))?;
            } else if let Some(at) = walk_items(c, None, items, is_sequence, v, depth + 1)? {
                return Ok(Some(at));
            }
        } else {
            let seq_end = c.pos.checked_add(h.len as usize).filter(|&e| e <= c.buf.len()).ok_or_else(|| invalid("sequence past the end of data"))?;
            if step == Step::Skip {
                c.pos = seq_end;
            } else if let Some(at) = walk_items(c, Some(seq_end), s, is_sequence, v, depth + 1)? {
                return Ok(Some(at));
            }
        }
    }
    Ok(None)
}

/// The items of a sequence (defined length: up to `end`; else to its delimiter).
fn walk_items<'a>(c: &mut Cursor<'a>, end: Option<usize>, s: Syntax, is_sequence: &dyn Fn(u32) -> bool, v: &mut dyn Visitor<'a>, depth: u32) -> Result<Option<usize>, Error> {
    if depth > MAX_DEPTH {
        return Err(invalid("sequences nested too deeply"));
    }
    let mut index = 0usize;
    loop {
        if end.is_some_and(|e| c.pos >= e) {
            break;
        }
        let group = c.u16(s.little)?;
        let element = c.u16(s.little)?;
        let len = c.u32(s.little)?;
        match (group, element) {
            (0xFFFE, 0xE0DD) => break,
            (0xFFFE, 0xE000) => {
                v.item(index, depth);
                let item_syntax = detect_vr_mode(c, s, false);
                let item_end = if len == UNDEFINED {
                    end.unwrap_or(c.buf.len())
                } else {
                    c.pos.checked_add(len as usize).filter(|&e| e <= end.unwrap_or(c.buf.len())).ok_or_else(|| invalid("item past the end of its sequence"))?
                };
                if let Some(at) = walk_elements(c, item_end, item_syntax, is_sequence, v, depth)? {
                    return Ok(Some(at));
                }
                if len != UNDEFINED {
                    c.pos = item_end;
                }
                v.item_end(depth);
                index += 1;
            }
            _ => return Err(invalid(format!("expected an item in sequence, found ({group:04X},{element:04X})"))),
        }
    }
    v.sequence_end(depth);
    Ok(None)
}

/// Parse encapsulated items stored inside a defined-length Pixel Data value.
pub fn parse_items(data: &[u8], little: bool) -> Result<PixelValue<'_>, Error> {
    read_encapsulated(&mut Cursor::new(data), Syntax { explicit: true, little })
}

/// Parse the items of encapsulated Pixel Data (PS3.5 A.4).
fn read_encapsulated<'a>(c: &mut Cursor<'a>, s: Syntax) -> Result<PixelValue<'a>, Error> {
    /// A last fragment may claim this many bytes more than are left (an off-by-one length, or
    /// a missing pad byte). Anything more is a truncated file and stays an error.
    const OVERRUN_SLACK: usize = 2;
    let mut basic_offsets: &[u8] = &[];
    let mut fragments = Vec::new();
    let mut first = true;
    let mut origin = 0usize;
    let mut note = None;
    loop {
        if c.remaining() == 0 {
            // pydicom stops quietly at the end of the data; a missing delimiter is tolerated.
            break;
        }
        // After at least one fragment, a damaged ending (CENSUS.md: "odd-length last fragment,
        // fragment length off by one, garbage terminator") ends the pixel data instead of
        // refusing the file: it is the last element read.
        let damaged_end_ok = !fragments.is_empty();
        if damaged_end_ok && c.remaining() < 8 {
            note = Some(format!("{} stray byte(s) after the last fragment ignored", c.remaining()));
            break;
        }
        let item_pos = c.pos;
        let group = c.u16(s.little)?;
        let element = c.u16(s.little)?;
        let len = c.u32(s.little)?;
        match (group, element) {
            (0xFFFE, 0xE0DD) => break,
            (0xFFFE, 0xE000) => {
                if len == UNDEFINED {
                    return Err(invalid("undefined item length in encapsulated pixel data"));
                }
                let len = len as usize;
                let data = if !first && len > c.remaining() && len - c.remaining() <= OVERRUN_SLACK {
                    note = Some(format!(
                        "last fragment claims {len} bytes but {} remain; the remaining bytes used",
                        c.remaining()
                    ));
                    c.take(c.remaining())?
                } else {
                    c.take(len)?
                };
                if first {
                    if !len.is_multiple_of(4) {
                        return Err(invalid(format!("Basic Offset Table length {len} is not a multiple of 4")));
                    }
                    basic_offsets = data;
                    first = false;
                    origin = c.pos;
                } else {
                    let offset = item_pos.saturating_sub(origin) as u64;
                    fragments.push(Fragment { offset, data });
                }
            }
            _ if damaged_end_ok => {
                note = Some(format!(
                    "({group:04X},{element:04X}) where an item or sequence delimiter belongs; pixel data ends at the last fragment"
                ));
                break;
            }
            _ => {
                return Err(invalid(format!(
                    "unexpected ({group:04X},{element:04X}) in encapsulated pixel data"
                )))
            }
        }
    }
    if first {
        return Err(invalid("encapsulated pixel data has no Basic Offset Table item"));
    }
    Ok(PixelValue::Encapsulated { basic_offsets, fragments, note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_bare_dataset_encoding() {
        // (0008,0016) UI, explicit LE
        assert_eq!(guess_syntax(b"\x08\x00\x16\x00UI\x02\x00"), EXPLICIT_LE);
        // same tag, explicit BE
        assert_eq!(guess_syntax(b"\x00\x08\x00\x16UI\x00\x02"), EXPLICIT_BE);
        // implicit LE: length bytes where the VR would be
        assert_eq!(guess_syntax(b"\x08\x00\x16\x00\x02\x00\x00\x00"), IMPLICIT_LE);
    }

    #[test]
    fn truncated_value_is_invalid() {
        let ds = b"\x28\x00\x10\x00US\x02\x00\x40";
        assert!(matches!(read_dataset(ds, EXPLICIT_LE), Err(Error::Invalid(_))));
    }

    #[test]
    fn huge_declared_length_does_not_allocate() {
        let ds = b"\x28\x00\x10\x00OB\x00\x00\xF0\xFF\xFF\xFF";
        assert!(matches!(read_dataset(ds, EXPLICIT_LE), Err(Error::Invalid(_))));
    }

    #[test]
    fn skips_nested_undefined_sequences() {
        let mut ds = Vec::new();
        // (0008,1140) SQ undefined, one undefined item containing (0008,1150) UI "1"
        ds.extend_from_slice(b"\x08\x00\x40\x11SQ\x00\x00\xFF\xFF\xFF\xFF");
        ds.extend_from_slice(b"\xFE\xFF\x00\xE0\xFF\xFF\xFF\xFF");
        ds.extend_from_slice(b"\x08\x00\x50\x11UI\x02\x001\x00");
        ds.extend_from_slice(b"\xFE\xFF\x0D\xE0\x00\x00\x00\x00");
        ds.extend_from_slice(b"\xFE\xFF\xDD\xE0\x00\x00\x00\x00");
        ds.extend_from_slice(b"\x28\x00\x10\x00US\x02\x00\x40\x00");
        let a = read_dataset(&ds, EXPLICIT_LE).unwrap();
        assert_eq!(a.rows, Some(&b"\x40\x00"[..]));
    }

    #[test]
    fn deep_nesting_is_refused() {
        let mut ds = Vec::new();
        for _ in 0..200 {
            ds.extend_from_slice(b"\x08\x00\x40\x11SQ\x00\x00\xFF\xFF\xFF\xFF");
            ds.extend_from_slice(b"\xFE\xFF\x00\xE0\xFF\xFF\xFF\xFF");
        }
        assert!(matches!(read_dataset(&ds, EXPLICIT_LE), Err(Error::Invalid(_))));
    }

    #[test]
    fn meta_without_dicm() {
        let mut f = Vec::new();
        let ts = b"1.2.840.10008.1.2\0";
        f.extend_from_slice(b"\x02\x00\x10\x00UI");
        f.extend_from_slice(&(ts.len() as u16).to_le_bytes());
        f.extend_from_slice(ts);
        f.extend_from_slice(b"\x28\x00\x10\x00\x02\x00\x00\x00\x40\x00");
        let p = prepare(&f).unwrap();
        assert_eq!(p.transfer_syntax.as_deref(), Some(TS_IMPLICIT_LE));
        let a = read_dataset(&p.dataset, p.syntax).unwrap();
        assert_eq!(a.rows, Some(&b"\x40\x00"[..]));
    }
}
