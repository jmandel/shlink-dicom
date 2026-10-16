//! A DICOM data set as a tree of elements, read from Explicit or Implicit VR Little Endian and
//! written as Explicit VR Little Endian.
//!
//! Values are kept as the bytes in the file. Reading Implicit VR takes each VR from the data
//! dictionary (`dict.rs`, generated from PS3.6); writing recomputes the lengths of defined-length
//! sequences and items (Explicit VR headers can be longer) and of group length elements, and keeps
//! undefined lengths undefined. A data set read from Explicit VR LE and written back is the same
//! bytes, as long as its lengths were right.



const UNDEFINED: u32 = 0xFFFF_FFFF;
const MAX_DEPTH: u32 = 64;
pub(crate) const PIXEL_DATA: u32 = 0x7FE0_0010;

#[derive(Debug)]
pub(crate) struct Elem<'a> {
    pub tag: u32,
    /// The VR as read (Explicit VR), or from the dictionary (Implicit VR); `AMBIGUOUS` when the
    /// dictionary lists several, resolved when writing ([`resolve_vr`]).
    pub vr: [u8; 2],
    pub value: Value<'a>,
}

#[derive(Debug)]
pub(crate) enum Value<'a> {
    /// A defined-length value.
    Bytes(&'a [u8]),
    /// A sequence of items.
    Seq { items: Vec<Item<'a>>, undefined: bool },
    /// An undefined-length value other than a sequence, kept as its bytes up to and including the
    /// sequence delimiter: UN holding Implicit VR items (PS3.5 6.2.2), or encapsulated pixel data
    /// in an icon sequence.
    Raw(&'a [u8]),
    /// New encapsulated Pixel Data: the Basic Offset Table item value, then one fragment per frame.
    Encapsulated { bot: Vec<u8>, fragments: Vec<Vec<u8>> },
    /// A replaced defined-length value.
    Owned(Vec<u8>),
}

#[derive(Debug)]
pub(crate) struct Item<'a> {
    pub elems: Vec<Elem<'a>>,
    pub undefined: bool,
}

pub(crate) const AMBIGUOUS: [u8; 2] = *b"??";

fn long_vr(vr: &[u8; 2]) -> bool {
    matches!(vr, b"OB" | b"OD" | b"OF" | b"OL" | b"OV" | b"OW" | b"SQ" | b"SV" | b"UC" | b"UN" | b"UR" | b"UT" | b"UV")
}

fn u16_at(b: &[u8], p: usize) -> Result<u16, String> {
    b.get(p..p + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| format!("truncated at offset {p}"))
}

fn u32_at(b: &[u8], p: usize) -> Result<u32, String> {
    b.get(p..p + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| format!("truncated at offset {p}"))
}

/// The VR of `tag` in an Implicit VR data set: the dictionary's, LO for private creators, UL for
/// group lengths, and UN for anything else unknown (private elements included).
fn implicit_vr(tag: u32) -> [u8; 2] {
    let (group, element) = ((tag >> 16) as u16, tag as u16);
    if element == 0 {
        return *b"UL";
    }
    if group % 2 == 1 {
        return if (0x0010..=0x00FF).contains(&element) { *b"LO" } else { *b"UN" };
    }
    match crate::vrs_of(tag) {
        Some([one]) => *one,
        Some(_) => AMBIGUOUS,
        None => *b"UN",
    }
}

pub(crate) struct Reader<'a> {
    pub buf: &'a [u8],
    pub explicit: bool,
}

impl<'a> Reader<'a> {
    /// Elements from `pos` to `end`, or (for an undefined-length item) to its item delimiter.
    /// Returns the elements and the position after them (after the delimiter, if any).
    pub fn elems(&self, mut pos: usize, end: usize, in_undefined_item: bool, depth: u32) -> Result<(Vec<Elem<'a>>, usize), String> {
        if depth > MAX_DEPTH {
            return Err("sequences nested too deeply".into());
        }
        let b = self.buf;
        let mut out = Vec::new();
        while pos < end {
            let group = u16_at(b, pos)?;
            let element = u16_at(b, pos + 2)?;
            let tag = (u32::from(group) << 16) | u32::from(element);
            if group == 0xFFFE {
                if element == 0xE00D && in_undefined_item {
                    return Ok((out, pos + 8));
                }
                return Err(format!("unexpected ({group:04X},{element:04X}) in a data set"));
            }
            let (vr, len, vstart) = if self.explicit {
                let vr: [u8; 2] = b.get(pos + 4..pos + 6).and_then(|s| s.try_into().ok()).ok_or("truncated")?;
                if !vr.iter().all(u8::is_ascii_uppercase) {
                    return Err(format!("({group:04X},{element:04X}) has no explicit VR"));
                }
                if long_vr(&vr) {
                    (vr, u32_at(b, pos + 8)?, pos + 12)
                } else {
                    (vr, u32::from(u16_at(b, pos + 6)?), pos + 8)
                }
            } else {
                let mut vr = implicit_vr(tag);
                let len = u32_at(b, pos + 4)?;
                if len == UNDEFINED && vr != *b"SQ" && tag != PIXEL_DATA {
                    vr = *b"SQ"; // an undefined length in Implicit VR is a sequence
                }
                (vr, len, pos + 8)
            };
            if len == UNDEFINED {
                if vr == *b"SQ" {
                    let (items, next) = self.items(vstart, end, true, depth + 1)?;
                    out.push(Elem { tag, vr, value: Value::Seq { items, undefined: true } });
                    pos = next;
                } else if matches!(&vr, b"UN" | b"OB" | b"OW") {
                    let next = skip_undefined(b, vstart, depth + 1)?;
                    out.push(Elem { tag, vr, value: Value::Raw(&b[vstart..next]) });
                    pos = next;
                } else {
                    return Err(format!("undefined length on ({group:04X},{element:04X})"));
                }
                continue;
            }
            let vend = vstart.checked_add(len as usize).filter(|&e| e <= b.len()).ok_or_else(|| {
                format!("({group:04X},{element:04X}) claims {len} bytes past the end of the data")
            })?;
            if vr == *b"SQ" {
                let (items, _) = self.items(vstart, vend, false, depth + 1)?;
                out.push(Elem { tag, vr, value: Value::Seq { items, undefined: false } });
            } else {
                out.push(Elem { tag, vr, value: Value::Bytes(&b[vstart..vend]) });
            }
            pos = vend;
        }
        if in_undefined_item {
            return Err("item without an item delimiter".into());
        }
        Ok((out, pos))
    }

    /// Items of a sequence starting at `pos`: up to `end` (defined length) or the sequence
    /// delimiter (undefined).
    fn items(&self, mut pos: usize, end: usize, undefined: bool, depth: u32) -> Result<(Vec<Item<'a>>, usize), String> {
        let b = self.buf;
        let mut items = Vec::new();
        loop {
            if !undefined && pos >= end {
                return Ok((items, pos));
            }
            let (group, element, len) = (u16_at(b, pos)?, u16_at(b, pos + 2)?, u32_at(b, pos + 4)?);
            pos += 8;
            match (group, element) {
                (0xFFFE, 0xE0DD) if undefined => return Ok((items, pos)),
                (0xFFFE, 0xE000) if len == UNDEFINED => {
                    let (elems, next) = self.elems(pos, b.len(), true, depth)?;
                    items.push(Item { elems, undefined: true });
                    pos = next;
                }
                (0xFFFE, 0xE000) => {
                    let iend = pos.checked_add(len as usize).filter(|&e| e <= b.len()).ok_or("item past the end of the data")?;
                    let (elems, _) = self.elems(pos, iend, false, depth)?;
                    items.push(Item { elems, undefined: false });
                    pos = iend;
                }
                _ => return Err(format!("expected an item, found ({group:04X},{element:04X})")),
            }
        }
    }
}

/// Skip the items of an undefined-length value to just after its sequence delimiter.
fn skip_undefined(b: &[u8], mut pos: usize, depth: u32) -> Result<usize, String> {
    if depth > MAX_DEPTH {
        return Err("sequences nested too deeply".into());
    }
    loop {
        let (group, element, len) = (u16_at(b, pos)?, u16_at(b, pos + 2)?, u32_at(b, pos + 4)?);
        pos += 8;
        match (group, element) {
            (0xFFFE, 0xE0DD) => return Ok(pos),
            (0xFFFE, 0xE000) if len == UNDEFINED => {
                // Implicit VR items inside UN: walk elements until the item delimiter.
                loop {
                    let (g, e, l) = (u16_at(b, pos)?, u16_at(b, pos + 2)?, u32_at(b, pos + 4)?);
                    pos += 8;
                    if (g, e) == (0xFFFE, 0xE00D) {
                        break;
                    }
                    if l == UNDEFINED {
                        pos = skip_undefined(b, pos, depth + 1)?;
                    } else {
                        pos = pos.checked_add(l as usize).filter(|&p| p <= b.len()).ok_or("truncated item")?;
                    }
                }
            }
            (0xFFFE, 0xE000) => pos = pos.checked_add(len as usize).filter(|&p| p <= b.len()).ok_or("truncated item")?,
            _ => return Err(format!("expected an item, found ({group:04X},{element:04X})")),
        }
    }
}

/// The Explicit VR for an element whose dictionary entry lists several (PS3.5 A.1 c, as
/// pydicom's `correct_ambiguous_vr` decides): SS when Pixel Representation is 1, else US; OW for
/// "OB or OW" (OB when the length is odd); US for "US or OW" when the value fits a 2-byte
/// length, else OW.
fn resolve_vr(tag: u32, len: usize, signed: bool) -> [u8; 2] {
    let options = crate::vrs_of(tag).unwrap_or(&[]);
    let has = |v: &[u8; 2]| options.contains(v);
    if has(b"OB") && has(b"OW") {
        return if len % 2 == 1 { *b"OB" } else { *b"OW" };
    }
    if has(b"OW") && (len > 0xFFFE || len % 2 == 1) {
        return *b"OW";
    }
    if has(b"SS") && signed {
        return *b"SS";
    }
    if has(b"US") {
        return *b"US";
    }
    options.first().copied().unwrap_or(*b"UN")
}

pub(crate) struct Writer {
    /// Pixel Representation of the top-level data set, for US/SS.
    pub signed: bool,
}

impl Writer {
    /// Serialize `elems` as Explicit VR Little Endian, recomputing group lengths.
    pub fn elems(&self, out: &mut Vec<u8>, elems: &[Elem<'_>]) -> Result<(), String> {
        let mut ends = Vec::with_capacity(elems.len());
        for e in elems {
            self.elem(out, e)?;
            ends.push(out.len());
        }
        // Group length elements (gggg,0000) count the bytes of the rest of their group.
        for (k, e) in elems.iter().enumerate() {
            if e.tag & 0xFFFF != 0 || !matches!(e.value, Value::Bytes(v) if v.len() == 4) {
                continue;
            }
            let group = e.tag >> 16;
            let mut last = ends[k];
            for (j, f) in elems.iter().enumerate().skip(k + 1) {
                if f.tag >> 16 != group {
                    break;
                }
                last = ends[j];
            }
            let len = u32::try_from(last - ends[k]).map_err(|_| "group too long for its group length")?;
            let at = ends[k] - 4;
            out[at..at + 4].copy_from_slice(&len.to_le_bytes());
        }
        Ok(())
    }

    fn header(out: &mut Vec<u8>, tag: u32, vr: [u8; 2], len: u32) -> Result<(), String> {
        out.extend_from_slice(&((tag >> 16) as u16).to_le_bytes());
        out.extend_from_slice(&(tag as u16).to_le_bytes());
        out.extend_from_slice(&vr);
        if long_vr(&vr) {
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(&len.to_le_bytes());
        } else {
            let short = u16::try_from(len)
                .map_err(|_| format!("({:04X},{:04X}) {} value of {len} bytes needs a 4-byte length", tag >> 16, tag & 0xFFFF, vr[0] as char))?;
            out.extend_from_slice(&short.to_le_bytes());
        }
        Ok(())
    }

    fn elem(&self, out: &mut Vec<u8>, e: &Elem<'_>) -> Result<(), String> {
        match &e.value {
            Value::Bytes(_) | Value::Owned(_) => {
                let v: &[u8] = match &e.value {
                    Value::Bytes(v) => v,
                    Value::Owned(v) => v,
                    _ => &[],
                };
                let vr = if e.vr == AMBIGUOUS { resolve_vr(e.tag, v.len(), self.signed) } else { e.vr };
                Self::header(out, e.tag, vr, u32::try_from(v.len()).map_err(|_| "value too long")?)?;
                out.extend_from_slice(v);
            }
            Value::Raw(v) => {
                let vr = if e.vr == AMBIGUOUS { *b"UN" } else { e.vr };
                Self::header(out, e.tag, vr, UNDEFINED)?;
                out.extend_from_slice(v);
            }
            Value::Seq { items, undefined } => {
                let mut body = Vec::new();
                for item in items {
                    let mut content = Vec::new();
                    self.elems(&mut content, &item.elems)?;
                    body.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
                    if item.undefined {
                        body.extend_from_slice(&UNDEFINED.to_le_bytes());
                        body.extend_from_slice(&content);
                        body.extend_from_slice(&[0xFE, 0xFF, 0x0D, 0xE0, 0, 0, 0, 0]);
                    } else {
                        body.extend_from_slice(&u32::try_from(content.len()).map_err(|_| "item too long")?.to_le_bytes());
                        body.extend_from_slice(&content);
                    }
                }
                if *undefined {
                    Self::header(out, e.tag, *b"SQ", UNDEFINED)?;
                    out.extend_from_slice(&body);
                    out.extend_from_slice(&[0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
                } else {
                    Self::header(out, e.tag, *b"SQ", u32::try_from(body.len()).map_err(|_| "sequence too long")?)?;
                    out.extend_from_slice(&body);
                }
            }
            Value::Encapsulated { bot, fragments } => {
                Self::header(out, e.tag, *b"OB", UNDEFINED)?;
                let item = |out: &mut Vec<u8>, v: &[u8]| -> Result<(), String> {
                    out.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
                    out.extend_from_slice(&u32::try_from(v.len() + v.len() % 2).map_err(|_| "fragment too long")?.to_le_bytes());
                    out.extend_from_slice(v);
                    if v.len() % 2 == 1 {
                        out.push(0);
                    }
                    Ok(())
                };
                item(out, bot)?;
                for f in fragments {
                    item(out, f)?;
                }
                out.extend_from_slice(&[0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
            }
        }
        Ok(())
    }
}

/// Every value in the tree as (path, bytes), in order: the path is the chain of (tag, item
/// index) down to the element. Sequences contribute their items' elements; group lengths and the
/// elements in `skip` (top level only) are left out. Used to check that a rewrite changed no value.
pub(crate) fn flatten<'b>(elems: &'b [Elem<'_>], skip: &[u32]) -> Vec<(Vec<u32>, &'b [u8])> {
    fn walk<'b>(elems: &'b [Elem<'_>], path: &mut Vec<u32>, skip: &[u32], top: bool, out: &mut Vec<(Vec<u32>, &'b [u8])>) {
        for e in elems {
            if e.tag & 0xFFFF == 0 || (top && skip.contains(&e.tag)) {
                continue;
            }
            path.push(e.tag);
            match &e.value {
                Value::Bytes(v) | Value::Raw(v) => out.push((path.clone(), v)),
                Value::Owned(v) => out.push((path.clone(), v)),
                Value::Seq { items, .. } => {
                    out.push((path.clone(), &[]));
                    for (k, item) in items.iter().enumerate() {
                        path.push(0xFFFE_0000 | k as u32);
                        walk(&item.elems, path, skip, false, out);
                        path.pop();
                    }
                }
                Value::Encapsulated { .. } => out.push((path.clone(), &[])),
            }
            path.pop();
        }
    }
    let mut out = Vec::new();
    walk(elems, &mut Vec::new(), skip, true, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_round_trip_is_identical() {
        let mut ds = Vec::new();
        // (0008,0060) CS "CT", (0008,1140) SQ undefined with one undefined item holding (0008,1150) UI.
        ds.extend_from_slice(b"\x08\x00\x60\x00CS\x02\x00CT");
        ds.extend_from_slice(b"\x08\x00\x40\x11SQ\x00\x00\xFF\xFF\xFF\xFF\xFE\xFF\x00\xE0\xFF\xFF\xFF\xFF");
        ds.extend_from_slice(b"\x08\x00\x50\x11UI\x02\x001\x00\xFE\xFF\x0D\xE0\x00\x00\x00\x00\xFE\xFF\xDD\xE0\x00\x00\x00\x00");
        let r = Reader { buf: &ds, explicit: true };
        let (elems, _) = r.elems(0, ds.len(), false, 0).unwrap();
        let mut out = Vec::new();
        Writer { signed: false }.elems(&mut out, &elems).unwrap();
        assert_eq!(out, ds);
    }

    #[test]
    fn implicit_becomes_explicit_with_dictionary_vrs() {
        let mut ds = Vec::new();
        ds.extend_from_slice(b"\x08\x00\x60\x00\x02\x00\x00\x00CT"); // Modality CS
        ds.extend_from_slice(b"\x09\x00\x10\x00\x04\x00\x00\x00ACME"); // private creator LO
        ds.extend_from_slice(b"\x09\x00\x01\x10\x02\x00\x00\x00\x01\x02"); // private UN
        ds.extend_from_slice(b"\x28\x00\x07\x01\x02\x00\x00\x00\xFF\x0F"); // Largest Image Pixel Value, US or SS
        let r = Reader { buf: &ds, explicit: false };
        let (elems, _) = r.elems(0, ds.len(), false, 0).unwrap();
        let mut out = Vec::new();
        Writer { signed: true }.elems(&mut out, &elems).unwrap();
        let mut want = Vec::new();
        want.extend_from_slice(b"\x08\x00\x60\x00CS\x02\x00CT");
        want.extend_from_slice(b"\x09\x00\x10\x00LO\x04\x00ACME");
        want.extend_from_slice(b"\x09\x00\x01\x10UN\x00\x00\x02\x00\x00\x00\x01\x02");
        want.extend_from_slice(b"\x28\x00\x07\x01SS\x02\x00\xFF\x0F");
        assert_eq!(out, want);
        let back = Reader { buf: &out, explicit: true }.elems(0, out.len(), false, 0).unwrap().0;
        assert_eq!(flatten(&elems, &[]), flatten(&back, &[]));
    }
}
