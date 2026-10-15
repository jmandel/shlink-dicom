//! Frame offset tables for encapsulated multi-frame instances (PS3.5 A.4).
//!
//! Many multi-frame files (whole-slide images in particular) ship with an empty Basic Offset
//! Table and no Extended Offset Table, so a reader must walk every fragment item header to find
//! frame *k*. Over SHL byte ranges that means downloading everything before the frame. When the
//! sharer asks for it, the packer fills the table in:
//!
//! - a **Basic Offset Table** in the first item of Pixel Data, when every offset fits in 32 bits;
//! - otherwise an **Extended Offset Table** (7FE0,0001) and **Lengths** (7FE0,0002) inserted just
//!   before Pixel Data, which PS3.5 allows only when each frame is one fragment. The BOT stays empty.
//!
//! Fragment bytes are never changed: the rewrite replaces only the bytes before the first fragment
//! item (the empty BOT item, or the Pixel Data element header for the EOT case). It is expressed
//! as an [`OffsetTablePatch`] (new head bytes + where the original resumes) so callers that hold
//! large files elsewhere (the browser) can splice without a second copy in wasm memory.
//!
//! An instance is rewritten only when all of these hold: Part 10, explicit VR little endian
//! encapsulated transfer syntax (not a video syntax), top-level Pixel Data of undefined length,
//! Number of Frames > 1, an empty BOT, no EOT, and frame boundaries that are unambiguous
//! (codestream start markers for JPEG/JPEG-LS/JPEG 2000/HTJ2K counting exactly Number of
//! Frames, or exactly one fragment per frame). Anything else is left as it is.

const UNDEF: u32 = 0xFFFF_FFFF;
const ITEM: u32 = 0xFFFE_E000;
const ITEM_DELIM: u32 = 0xFFFE_E00D;
const SEQ_DELIM: u32 = 0xFFFE_E0DD;
const PIXEL_DATA: u32 = 0x7FE0_0010;
const EOT_TAG: u32 = 0x7FE0_0001;
const EOT_LENGTHS_TAG: u32 = 0x7FE0_0002;
const NUMBER_OF_FRAMES: u32 = 0x0028_0008;

/// Which table a patch writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffsetTableKind {
    Basic,
    Extended,
}

/// What an instance needs (from its header alone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OffsetTableStatus {
    /// Not an encapsulated multi-frame instance (single frame, native, unsupported syntax…).
    NotApplicable,
    /// Already has a non-empty BOT or an EOT.
    HasTable,
    /// Encapsulated, `frames` frames, empty BOT and no EOT.
    Missing { frames: usize },
}

/// The rewrite: the new file is `head` followed by `original[resume_at..]`.
#[derive(Debug, Clone)]
pub struct OffsetTablePatch {
    pub head: Vec<u8>,
    pub resume_at: usize,
    pub frames: usize,
    pub kind: OffsetTableKind,
}

impl OffsetTablePatch {
    pub fn new_len(&self, original_len: usize) -> usize {
        self.head.len() + (original_len - self.resume_at)
    }

    pub fn apply(&self, original: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.new_len(original.len()));
        out.extend_from_slice(&self.head);
        out.extend_from_slice(&original[self.resume_at..]);
        out
    }
}

struct Header {
    ts: String,
    frames: usize,
    has_eot: bool,
    has_7fe0_group_length: bool,
    /// Start of the top-level Pixel Data element header.
    pixel_tag_pos: usize,
    /// Start of the BOT item header.
    bot_pos: usize,
    bot_len: u32,
}

fn u16le(b: &[u8], p: usize) -> Option<u16> {
    b.get(p..p + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32le(b: &[u8], p: usize) -> Option<u32> {
    b.get(p..p + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn tag_at(b: &[u8], p: usize) -> Option<u32> {
    Some(((u16le(b, p)? as u32) << 16) | u16le(b, p + 2)? as u32)
}

fn is_long_vr(vr: &[u8]) -> bool {
    matches!(vr, b"OB" | b"OD" | b"OF" | b"OL" | b"OV" | b"OW" | b"SQ" | b"SV" | b"UC" | b"UN" | b"UR" | b"UT" | b"UV")
}

/// One element header: (tag, vr, value offset, value length).
fn read_el(b: &[u8], p: usize, explicit: bool) -> Option<(u32, [u8; 2], usize, u32)> {
    let tag = tag_at(b, p)?;
    if tag >> 16 == 0xFFFE {
        return Some((tag, *b"  ", p + 8, u32le(b, p + 4)?));
    }
    let vr = b.get(p + 4..p + 6)?;
    if explicit && vr[0].is_ascii_uppercase() && vr[1].is_ascii_uppercase() {
        let vr = [vr[0], vr[1]];
        if is_long_vr(&vr) {
            Some((tag, vr, p + 12, u32le(b, p + 8)?))
        } else {
            Some((tag, vr, p + 8, u16le(b, p + 6)? as u32))
        }
    } else {
        Some((tag, *b"  ", p + 8, u32le(b, p + 4)?))
    }
}

/// Skips an undefined-length value starting at `p`; returns the position after its delimiter.
fn skip_undefined(b: &[u8], mut p: usize, explicit: bool, depth: u32) -> Option<usize> {
    if depth > 64 {
        return None;
    }
    loop {
        let (tag, vr, vo, len) = read_el(b, p, explicit)?;
        if tag == SEQ_DELIM || tag == ITEM_DELIM {
            return Some(vo);
        }
        if len == UNDEF {
            // Undefined-length UN holds implicit VR data (PS3.5 6.2.2).
            let nested_explicit = explicit && &vr != b"UN";
            p = skip_undefined(b, vo, nested_explicit, depth + 1)?;
        } else {
            p = vo.checked_add(len as usize)?;
        }
        if p > b.len() {
            return None;
        }
    }
}

const VIDEO_TS: &[&str] = &[
    "1.2.840.10008.1.2.4.100", "1.2.840.10008.1.2.4.100.1", "1.2.840.10008.1.2.4.101", "1.2.840.10008.1.2.4.101.1",
    "1.2.840.10008.1.2.4.102", "1.2.840.10008.1.2.4.102.1", "1.2.840.10008.1.2.4.103", "1.2.840.10008.1.2.4.103.1",
    "1.2.840.10008.1.2.4.104", "1.2.840.10008.1.2.4.104.1", "1.2.840.10008.1.2.4.105", "1.2.840.10008.1.2.4.105.1",
    "1.2.840.10008.1.2.4.106", "1.2.840.10008.1.2.4.106.1", "1.2.840.10008.1.2.4.107", "1.2.840.10008.1.2.4.108",
];

fn scan_header(b: &[u8]) -> Option<Header> {
    if b.get(128..132)? != b"DICM" {
        return None;
    }
    let mut p = 132;
    let mut ts = String::new();
    while u16le(b, p)? == 0x0002 {
        let (tag, _, vo, len) = read_el(b, p, true)?;
        if len == UNDEF {
            return None;
        }
        if tag == 0x0002_0010 {
            ts = String::from_utf8_lossy(b.get(vo..vo + len as usize)?).trim_end_matches(['\0', ' ']).to_string();
        }
        p = vo + len as usize;
    }
    // Implicit VR, big endian and deflated data sets are never encapsulated-and-rewritable here.
    if matches!(ts.as_str(), "1.2.840.10008.1.2" | "1.2.840.10008.1.2.1" | "1.2.840.10008.1.2.2" | "1.2.840.10008.1.2.1.99" | "")
        || VIDEO_TS.contains(&ts.as_str())
    {
        return None;
    }
    let mut frames = 1usize;
    let mut has_eot = false;
    let mut has_gl = false;
    loop {
        let (tag, vr, vo, len) = read_el(b, p, true)?;
        if tag == PIXEL_DATA {
            if len != UNDEF {
                return None; // native or malformed
            }
            let (bt, _, bvo, blen) = read_el(b, vo, true)?;
            if bt != ITEM || blen == UNDEF {
                return None;
            }
            let _ = bvo;
            return Some(Header { ts, frames, has_eot, has_7fe0_group_length: has_gl, pixel_tag_pos: p, bot_pos: vo, bot_len: blen });
        }
        if tag > PIXEL_DATA {
            return None;
        }
        match tag {
            NUMBER_OF_FRAMES if len != UNDEF => {
                let s = String::from_utf8_lossy(b.get(vo..vo + len as usize)?).to_string();
                frames = s.trim_matches(['\0', ' ']).split('\\').next()?.trim().parse::<usize>().unwrap_or(1).max(1);
            }
            EOT_TAG | EOT_LENGTHS_TAG => has_eot = true,
            0x7FE0_0000 => has_gl = true,
            _ => {}
        }
        p = if len == UNDEF { skip_undefined(b, vo, &vr != b"UN", 1)? } else { vo.checked_add(len as usize)? };
    }
}

/// What the instance needs, from its header. Reads only up to the BOT item.
pub fn offset_table_status(bytes: &[u8]) -> OffsetTableStatus {
    match scan_header(bytes) {
        None => OffsetTableStatus::NotApplicable,
        Some(h) if h.frames < 2 => OffsetTableStatus::NotApplicable,
        Some(h) if h.has_eot || h.bot_len > 0 => OffsetTableStatus::HasTable,
        Some(h) => OffsetTableStatus::Missing { frames: h.frames },
    }
}

fn frame_start_test(ts: &str) -> Option<fn(&[u8]) -> bool> {
    const JPEG: &[&str] = &["1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.57", "1.2.840.10008.1.2.4.70", "1.2.840.10008.1.2.4.80", "1.2.840.10008.1.2.4.81"];
    const J2K: &[&str] = &["1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91", "1.2.840.10008.1.2.4.92", "1.2.840.10008.1.2.4.93", "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202", "1.2.840.10008.1.2.4.203"];
    if JPEG.contains(&ts) {
        Some(|v| v.len() >= 2 && v[0] == 0xFF && v[1] == 0xD8)
    } else if J2K.contains(&ts) {
        Some(|v| (v.len() >= 2 && v[0] == 0xFF && v[1] == 0x4F) || v.starts_with(&[0, 0, 0, 0x0C, 0x6A, 0x50, 0x20, 0x20]))
    } else {
        None
    }
}

/// Computes the rewrite that adds an offset table, or `None` when the instance does not need one
/// or its frames cannot be located unambiguously.
pub fn offset_table_patch(bytes: &[u8]) -> Option<OffsetTablePatch> {
    patch_with_limit(bytes, u32::MAX as u64)
}

/// `bot_limit`: the largest offset a BOT may hold (u32::MAX; tests lower it to reach the EOT path).
fn patch_with_limit(bytes: &[u8], bot_limit: u64) -> Option<OffsetTablePatch> {
    let h = scan_header(bytes)?;
    if h.frames < 2 || h.has_eot || h.bot_len != 0 {
        return None;
    }
    // Fragments: (item header position, value length).
    let first_item = h.bot_pos + 8;
    let mut frags: Vec<(usize, u32)> = Vec::new();
    let mut p = first_item;
    loop {
        let tag = tag_at(bytes, p)?;
        let len = u32le(bytes, p + 4)?;
        if tag == SEQ_DELIM {
            break;
        }
        if tag != ITEM || len == UNDEF {
            return None;
        }
        let end = (p + 8).checked_add(len as usize)?;
        if end > bytes.len() {
            return None;
        }
        frags.push((p, len));
        p = end;
    }
    // Frame starts, as indices into frags.
    let by_marker: Option<Vec<usize>> = frame_start_test(&h.ts).map(|test| {
        frags
            .iter()
            .enumerate()
            .filter(|(i, (fp, len))| *i == 0 || test(&bytes[fp + 8..fp + 8 + (*len as usize).min(8)]))
            .map(|(i, _)| i)
            .collect()
    });
    let starts: Vec<usize> = match by_marker {
        Some(s) if s.len() == h.frames => s,
        _ if frags.len() == h.frames => (0..frags.len()).collect(),
        _ => return None,
    };
    let offsets: Vec<u64> = starts.iter().map(|&i| (frags[i].0 - first_item) as u64).collect();
    let fits_32 = offsets.last().is_none_or(|&o| o <= bot_limit) && h.frames * 4 <= u32::MAX as usize;
    if fits_32 {
        let mut head = Vec::with_capacity(h.bot_pos + 8 + 4 * h.frames);
        head.extend_from_slice(&bytes[..h.bot_pos]);
        head.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
        head.extend_from_slice(&((4 * h.frames) as u32).to_le_bytes());
        for o in &offsets {
            head.extend_from_slice(&(*o as u32).to_le_bytes());
        }
        return Some(OffsetTablePatch { head, resume_at: h.bot_pos + 8, frames: h.frames, kind: OffsetTableKind::Basic });
    }
    // Extended Offset Table: only when each frame is exactly one fragment (PS3.5 A.4), and not
    // when a 7FE0 group length would have to change.
    if starts.len() != frags.len() || h.has_7fe0_group_length {
        return None;
    }
    let mut head = Vec::with_capacity(h.pixel_tag_pos + 24 + 16 * h.frames);
    head.extend_from_slice(&bytes[..h.pixel_tag_pos]);
    for (tag, values) in [(EOT_TAG, offsets.clone()), (EOT_LENGTHS_TAG, frags.iter().map(|f| f.1 as u64).collect())] {
        head.extend_from_slice(&((tag >> 16) as u16).to_le_bytes());
        head.extend_from_slice(&((tag & 0xFFFF) as u16).to_le_bytes());
        head.extend_from_slice(b"OV\0\0");
        head.extend_from_slice(&((8 * values.len()) as u32).to_le_bytes());
        for v in values {
            head.extend_from_slice(&v.to_le_bytes());
        }
    }
    Some(OffsetTablePatch { head, resume_at: h.pixel_tag_pos, frames: h.frames, kind: OffsetTableKind::Extended })
}

/// Adds an offset table when one is missing; returns the bytes (unchanged if not needed) and
/// whether they changed.
pub fn add_offset_table(bytes: Vec<u8>) -> (Vec<u8>, bool) {
    match offset_table_patch(&bytes) {
        Some(p) => (p.apply(&bytes), true),
        None => (bytes, false),
    }
}

/// For tests: frames (concatenated fragment values) of an encapsulated instance, located through
/// its BOT or EOT when present, else by the same rules as the rewrite.
#[cfg(test)]
pub(crate) fn frames_of(bytes: &[u8]) -> Option<Vec<Vec<u8>>> {
    let h = scan_header(bytes)?;
    let first_item = h.bot_pos + 8 + h.bot_len as usize;
    let mut frags = Vec::new();
    let mut p = first_item;
    while tag_at(bytes, p)? == ITEM {
        let len = u32le(bytes, p + 4)? as usize;
        frags.push((p, len));
        p += 8 + len;
    }
    let mut boundaries: Vec<usize> = if h.bot_len > 0 {
        (0..h.bot_len as usize / 4).map(|i| first_item + u32le(bytes, h.bot_pos + 8 + 4 * i).unwrap() as usize).collect()
    } else {
        let patch = offset_table_patch(bytes);
        match patch {
            Some(_) => {
                let rewritten = add_offset_table(bytes.to_vec()).0;
                return frames_of(&rewritten);
            }
            None if h.has_eot => {
                // Find the EOT values.
                let mut q = 132;
                while u16le(bytes, q)? == 0x0002 {
                    let (_, _, vo, len) = read_el(bytes, q, true)?;
                    q = vo + len as usize;
                }
                let mut eot = Vec::new();
                loop {
                    let (tag, vr, vo, len) = read_el(bytes, q, true)?;
                    if tag == EOT_TAG {
                        eot = (0..len as usize / 8).map(|i| u64::from_le_bytes(bytes[vo + 8 * i..vo + 8 * i + 8].try_into().unwrap()) as usize).collect();
                    }
                    if tag == PIXEL_DATA {
                        break;
                    }
                    q = if len == UNDEF { skip_undefined(bytes, vo, &vr != b"UN", 1)? } else { vo + len as usize };
                }
                eot.iter().map(|o| first_item + o).collect()
            }
            None => frags.iter().map(|f| f.0).collect(),
        }
    };
    boundaries.push(p);
    let mut out = Vec::new();
    for w in boundaries.windows(2) {
        let mut frame = Vec::new();
        for &(fp, len) in frags.iter().filter(|(fp, _)| *fp >= w[0] && *fp < w[1]) {
            frame.extend_from_slice(&bytes[fp + 8..fp + 8 + len]);
        }
        out.push(frame);
    }
    Some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A synthetic multi-frame JPEG-baseline-syntax file: `frames` frames, frame k split into
    /// `split[k]` fragments, each starting with SOI only at the frame's first fragment.
    pub(crate) fn synthetic(frames: usize, split: &[usize], with_seq: bool) -> Vec<u8> {
        let mut b = vec![0u8; 128];
        b.extend_from_slice(b"DICM");
        let el = |b: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8]| {
            b.extend_from_slice(&g.to_le_bytes());
            b.extend_from_slice(&e.to_le_bytes());
            b.extend_from_slice(vr);
            if is_long_vr(vr) {
                b.extend_from_slice(&[0, 0]);
                b.extend_from_slice(&(v.len() as u32).to_le_bytes());
            } else {
                b.extend_from_slice(&(v.len() as u16).to_le_bytes());
            }
            b.extend_from_slice(v);
        };
        let ts = b"1.2.840.10008.1.2.4.50\0";
        let mut meta = Vec::new();
        el(&mut meta, 0x0002, 0x0001, b"OB", &[0, 1]);
        el(&mut meta, 0x0002, 0x0002, b"UI", b"1.2.840.10008.5.1.4.1.1.77.1.6\0");
        el(&mut meta, 0x0002, 0x0003, b"UI", b"1.2.3.4.5.6\0");
        el(&mut meta, 0x0002, 0x0010, b"UI", ts);
        el(&mut b, 0x0002, 0x0000, b"UL", &(meta.len() as u32).to_le_bytes());
        b.extend_from_slice(&meta);
        el(&mut b, 0x0008, 0x0016, b"UI", b"1.2.840.10008.5.1.4.1.1.77.1.6\0");
        el(&mut b, 0x0008, 0x0018, b"UI", b"1.2.3.4.5.6\0");
        el(&mut b, 0x0008, 0x0060, b"CS", b"SM");
        if with_seq {
            el(&mut b, 0x0008, 0x0070, b"LO", b"x ");
            // An undefined-length sequence with an undefined-length item, to exercise skipping.
            b.extend_from_slice(&[0x08, 0x00, 0x15, 0x11, b'S', b'Q', 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
            b.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0, 0xFF, 0xFF, 0xFF, 0xFF]);
            el(&mut b, 0x0008, 0x1155, b"UI", b"1.2.3\0");
            b.extend_from_slice(&[0xFE, 0xFF, 0x0D, 0xE0, 0, 0, 0, 0]);
            b.extend_from_slice(&[0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
        }
        el(&mut b, 0x0010, 0x0010, b"PN", b"Test^Slide");
        el(&mut b, 0x0020, 0x000D, b"UI", b"1.2.3.4\0");
        el(&mut b, 0x0020, 0x000E, b"UI", b"1.2.3.4.1\0");
        el(&mut b, 0x0020, 0x0013, b"IS", b"1 ");
        el(&mut b, 0x0028, 0x0002, b"US", &1u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0004, b"CS", b"MONOCHROME2 ");
        let nf = format!("{frames}");
        let nf = if nf.len() % 2 == 1 { format!("{nf} ") } else { nf };
        el(&mut b, 0x0028, 0x0008, b"IS", nf.as_bytes());
        el(&mut b, 0x0028, 0x0010, b"US", &8u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0011, b"US", &8u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0100, b"US", &8u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0101, b"US", &8u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0102, b"US", &7u16.to_le_bytes());
        el(&mut b, 0x0028, 0x0103, b"US", &0u16.to_le_bytes());
        b.extend_from_slice(&[0xE0, 0x7F, 0x10, 0x00, b'O', b'B', 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
        b.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0, 0, 0, 0, 0]);
        for k in 0..frames {
            for f in 0..split[k % split.len()] {
                let mut v = if f == 0 { vec![0xFF, 0xD8] } else { vec![0x11, 0x22] };
                v.extend((0..(10 + 7 * k + 3 * f)).map(|i| (i * 31 + k) as u8));
                if v.len() % 2 == 1 {
                    v.push(0);
                }
                b.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
                b.extend_from_slice(&(v.len() as u32).to_le_bytes());
                b.extend_from_slice(&v);
            }
        }
        b.extend_from_slice(&[0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
        b
    }

    #[test]
    fn fills_basic_offset_table_and_keeps_frames() {
        for (split, seq) in [(vec![1], false), (vec![1, 2, 3], true)] {
            let src = synthetic(7, &split, seq);
            assert_eq!(offset_table_status(&src), OffsetTableStatus::Missing { frames: 7 });
            let before = frames_of(&src).unwrap();
            let (out, changed) = add_offset_table(src.clone());
            assert!(changed);
            assert_eq!(out.len(), src.len() + 4 * 7);
            assert_eq!(offset_table_status(&out), OffsetTableStatus::HasTable);
            let after = frames_of(&out).unwrap();
            assert_eq!(before, after);
            assert_eq!(after.len(), 7);
            // Each BOT offset points at an item whose value starts with SOI.
            let h = scan_header(&out).unwrap();
            let first = h.bot_pos + 8 + h.bot_len as usize;
            for k in 0..7 {
                let o = u32le(&out, h.bot_pos + 8 + 4 * k).unwrap() as usize;
                assert_eq!(tag_at(&out, first + o), Some(ITEM));
                assert_eq!(&out[first + o + 8..first + o + 10], &[0xFF, 0xD8]);
            }
            // Fragment bytes are identical: the tail after the BOT is byte-for-byte the original's.
            assert_eq!(&out[h.bot_pos + 8 + 28..], &src[h.bot_pos + 8..]);
            // A second pass changes nothing.
            assert!(!add_offset_table(out).1);
        }
    }

    #[test]
    fn leaves_single_frame_and_ambiguous_files() {
        let one = synthetic(1, &[1], false);
        assert_eq!(offset_table_status(&one), OffsetTableStatus::NotApplicable);
        assert!(!add_offset_table(one).1);
        // Frames split into fragments without start markers: 3 frames, 6 fragments, no SOI on the
        // continuation fragments → markers find 3 starts → fine. Break the markers to make it ambiguous.
        let mut amb = synthetic(3, &[2], false);
        let h = scan_header(&amb).unwrap();
        let mut p = h.bot_pos + 8;
        while tag_at(&amb, p) == Some(ITEM) {
            let len = u32le(&amb, p + 4).unwrap() as usize;
            amb[p + 8] = 0x00; // no SOI anywhere
            p += 8 + len;
        }
        assert!(!add_offset_table(amb).1);
    }

    #[test]
    fn extended_offset_table_when_offsets_exceed_the_limit() {
        let src = synthetic(4, &[1], true);
        let before = frames_of(&src).unwrap();
        let p = patch_with_limit(&src, 16).unwrap();
        assert_eq!(p.kind, OffsetTableKind::Extended);
        let out = p.apply(&src);
        assert_eq!(out.len(), src.len() + 2 * (12 + 8 * 4));
        assert_eq!(offset_table_status(&out), OffsetTableStatus::HasTable);
        assert_eq!(frames_of(&out).unwrap(), before);
        // The BOT stays empty; the tail from Pixel Data on is the original's.
        let h = scan_header(&out).unwrap();
        assert_eq!(h.bot_len, 0);
        assert_eq!(&out[h.pixel_tag_pos..], &src[scan_header(&src).unwrap().pixel_tag_pos..]);
        // Frames split over several fragments cannot use an EOT.
        assert!(patch_with_limit(&synthetic(4, &[2], false), 16).is_none());
    }

    #[test]
    #[ignore]
    fn write_samples_for_external_tools() {
        // cargo test -p shl-dicom-core offset_tables -- --ignored ; then pydicom / dcmdump the files.
        let dir = std::env::var("OFFSET_TABLE_SAMPLES").unwrap_or_else(|_| "/tmp/offset-table-samples".into());
        std::fs::create_dir_all(&dir).unwrap();
        let src = synthetic(7, &[1, 2, 3], true);
        std::fs::write(format!("{dir}/before.dcm"), &src).unwrap();
        std::fs::write(format!("{dir}/bot.dcm"), add_offset_table(src.clone()).0).unwrap();
        let one = synthetic(5, &[1], false);
        std::fs::write(format!("{dir}/before-eot.dcm"), &one).unwrap();
        std::fs::write(format!("{dir}/eot.dcm"), patch_with_limit(&one, 16).unwrap().apply(&one)).unwrap();
        for (name, bytes) in [("before", &src), ("before-eot", &one)] {
            let frames = frames_of(bytes).unwrap();
            let mut all = Vec::new();
            for f in frames {
                all.extend_from_slice(&(f.len() as u32).to_le_bytes());
                all.extend_from_slice(&f);
            }
            std::fs::write(format!("{dir}/{name}.frames"), all).unwrap();
        }
    }
}
