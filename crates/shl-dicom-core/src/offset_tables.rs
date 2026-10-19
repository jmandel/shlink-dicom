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
//! (`shl_dicom_decode::syntax::frame_starts`: codestream start markers for JPEG, JPEG-LS,
//! JPEG 2000, HTJ2K and JPEG XL counting exactly Number of Frames, or exactly one fragment per
//! frame; the decoder splits frames by the same rule). Anything else is left as it is.

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
    /// Extended Offset Table values, when the instance has one.
    #[allow(dead_code)] // read by frames_of (tests)
    eot: Vec<u64>,
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
pub(crate) fn read_el(b: &[u8], p: usize, explicit: bool) -> Option<(u32, [u8; 2], usize, u32)> {
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
pub(crate) fn skip_undefined(b: &[u8], mut p: usize, explicit: bool, depth: u32) -> Option<usize> {
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

/// The header of an encapsulated instance up to its Basic Offset Table item, read with the
/// decoder's walker (`shl_dicom_decode::parse::walk`). None for native and video syntaxes, a
/// defined-length Pixel Data, or a prefix too short to reach the BOT item.
fn scan_header(b: &[u8]) -> Option<Header> {
    use shl_dicom_decode::{parse, syntax};
    if b.get(128..132)? != b"DICM" {
        return None;
    }
    let (ts, start) = parse::read_meta(b, 132).ok()?;
    let ts = ts.unwrap_or_default();
    // Implicit VR, big endian and deflated data sets are never encapsulated-and-rewritable here.
    if ts.is_empty() || syntax::is_native(&ts) || syntax::kind(&ts) == Some(syntax::Kind::Video) {
        return None;
    }
    struct Scan<'a> {
        frames: usize,
        has_eot: bool,
        eot: &'a [u8],
        has_gl: bool,
        pixel: Option<(usize, bool)>,
    }
    impl<'a> parse::Visitor<'a> for Scan<'a> {
        fn element(&mut self, e: &parse::Element<'a>) -> parse::Step {
            match (e.tag, e.value) {
                (PIXEL_DATA, v) => {
                    self.pixel = Some((e.pos, v.is_none()));
                    return parse::Step::Stop;
                }
                (NUMBER_OF_FRAMES, Some(v)) => {
                    let s = String::from_utf8_lossy(v).to_string();
                    self.frames = s.trim_matches(['\0', ' ']).split('\\').next().and_then(|f| f.trim().parse::<usize>().ok()).unwrap_or(1).max(1);
                }
                (EOT_TAG, Some(v)) => (self.has_eot, self.eot) = (true, v),
                (EOT_LENGTHS_TAG, _) => self.has_eot = true,
                (0x7FE0_0000, _) => self.has_gl = true,
                _ => {}
            }
            if e.value.is_none() { parse::Step::Skip } else { parse::Step::Next }
        }
    }
    let ds = b.get(start..)?;
    let mut scan = Scan { frames: 1, has_eot: false, eot: &[], has_gl: false, pixel: None };
    parse::walk(ds, parse::Syntax { explicit: true, little: true }, &|_| false, &mut scan).ok()?;
    let (pos, undefined) = scan.pixel?;
    if !undefined {
        return None; // native or malformed
    }
    let pixel_tag_pos = start + pos;
    // Pixel Data (OB/OW, undefined length) then its first item, the Basic Offset Table.
    let bot_pos = pixel_tag_pos + 12;
    if tag_at(b, bot_pos)? != ITEM {
        return None;
    }
    let bot_len = u32le(b, bot_pos + 4)?;
    if bot_len == UNDEF {
        return None;
    }
    let eot = scan.eot.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
    Some(Header { ts, frames: scan.frames, has_eot: scan.has_eot, eot, has_7fe0_group_length: scan.has_gl, pixel_tag_pos, bot_pos, bot_len })
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

/// Computes the rewrite that adds an offset table, or `None` when the instance does not need one
/// or its frames cannot be located unambiguously.
pub fn offset_table_patch(bytes: &[u8]) -> Option<OffsetTablePatch> {
    patch_with_limit(bytes, u32::MAX as u64)
}

/// Where the first fragment item starts (after the empty BOT item), when the instance needs a
/// table; `None` when it doesn't, or when `prefix` is too short to tell.
pub fn offset_table_first_fragment(prefix: &[u8]) -> Option<usize> {
    offset_table_probe(prefix)?.first_fragment
}

/// A completed inspection of an encapsulated instance's header.
pub struct OffsetTableProbe {
    /// Present only when a multi-frame instance needs a table.
    pub first_fragment: Option<usize>,
}

/// Inspect an encapsulated instance's prefix without reading its pixel payload. `None` means
/// the header could not be read yet (or is unsupported/malformed), not that it needs no table.
pub fn offset_table_probe(prefix: &[u8]) -> Option<OffsetTableProbe> {
    let h = scan_header(prefix)?;
    Some(OffsetTableProbe { first_fragment: (h.frames >= 2 && !h.has_eot && h.bot_len == 0).then_some(h.bot_pos + 8) })
}

/// One fragment item, for [`offset_table_patch_from_fragments`]: the position of its item header
/// in the file, its value length, and the first bytes of its value (up to 8).
pub struct FragmentInfo<'a> {
    pub pos: u64,
    pub len: u32,
    pub head: &'a [u8],
}

/// Walks a file's fragment items from the first one, for a caller that reads the file in pieces:
/// [`want`](Self::want) says which bytes to read next (an item header and the first bytes of its
/// value), [`feed`](Self::feed) takes them, and [`fragments`](Self::fragments) lists the items once
/// the sequence delimiter is reached. The CLI reads through a file handle, the Share page through
/// its byte sources (`FragmentWalker` in shl-dicom-wasm), and both get the same items.
pub struct FragmentWalk {
    p: u64,
    file_len: u64,
    items: Vec<(u64, u32, [u8; 8], u8)>,
    state: WalkState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WalkState {
    Reading,
    Done,
    Failed,
}

impl FragmentWalk {
    /// `first`: where the first fragment item starts ([`offset_table_first_fragment`]);
    /// `file_len`: the file's length.
    pub fn new(first: u64, file_len: u64) -> Self {
        FragmentWalk { p: first, file_len, items: Vec::new(), state: WalkState::Reading }
    }

    /// The bytes to read next, as (position, count), or `None` when the walk has ended.
    pub fn want(&self) -> Option<(u64, usize)> {
        if self.state != WalkState::Reading {
            return None;
        }
        Some((self.p, self.file_len.saturating_sub(self.p).min(16) as usize))
    }

    /// The bytes at [`want`](Self::want)'s position (as many as it asked for).
    pub fn feed(&mut self, b: &[u8]) {
        if self.state != WalkState::Reading {
            return;
        }
        if b.len() < 8 {
            self.state = WalkState::Failed;
            return;
        }
        let tag = (u32::from(u16::from_le_bytes([b[0], b[1]])) << 16) | u32::from(u16::from_le_bytes([b[2], b[3]]));
        let len = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
        if tag == SEQ_DELIM {
            self.state = WalkState::Done;
            return;
        }
        let end = self.p + 8 + u64::from(len);
        if tag != ITEM || len == UNDEF || end > self.file_len {
            self.state = WalkState::Failed;
            return;
        }
        let n = (len as usize).min(8).min(b.len() - 8);
        let mut head = [0u8; 8];
        head[..n].copy_from_slice(&b[8..8 + n]);
        self.items.push((self.p, len, head, n as u8));
        self.p = end;
    }

    /// The fragment items, once the walk reached the sequence delimiter; `None` if it ended any
    /// other way (a truncated file, or something other than an item).
    pub fn fragments(&self) -> Option<Vec<FragmentInfo<'_>>> {
        (self.state == WalkState::Done)
            .then(|| self.items.iter().map(|(pos, len, head, n)| FragmentInfo { pos: *pos, len: *len, head: &head[..*n as usize] }).collect())
    }
}

/// The same rewrite as [`offset_table_patch`], from the file's first bytes (at least up to the
/// first fragment item) and a list of the fragment items, so a caller can walk a large file
/// without holding it.
pub fn offset_table_patch_from_fragments(prefix: &[u8], frags: &[FragmentInfo]) -> Option<OffsetTablePatch> {
    patch_parts(prefix, frags, u32::MAX as u64)
}

/// The same rewrite as [`offset_table_patch`], for a file read through `r` (`len` bytes long)
/// without holding it: the header is read in growing prefixes (256 KiB, 4 MiB, 32 MiB), then each
/// fragment item's header and first 8 bytes. `Ok(None)` when no table is needed or the frames
/// cannot be located unambiguously.
pub fn offset_table_patch_from_reader<R: std::io::Read + std::io::Seek>(r: &mut R, len: u64) -> std::io::Result<Option<OffsetTablePatch>> {
    use std::io::SeekFrom;
    let mut prefix = Vec::new();
    let mut first = None;
    for n in [256u64 << 10, 4 << 20, 32 << 20] {
        let n = n.min(len);
        prefix.resize(n as usize, 0);
        r.seek(SeekFrom::Start(0))?;
        r.read_exact(&mut prefix)?;
        // A header that does not end inside this prefix needs a longer one.
        if scan_header(&prefix).is_some() || n == len {
            first = offset_table_first_fragment(&prefix);
            break;
        }
    }
    let Some(first) = first else { return Ok(None) };
    let mut walk = FragmentWalk::new(first as u64, len);
    let mut buf = [0u8; 16];
    while let Some((at, n)) = walk.want() {
        r.seek(SeekFrom::Start(at))?;
        r.read_exact(&mut buf[..n])?;
        walk.feed(&buf[..n]);
    }
    Ok(walk.fragments().and_then(|frags| offset_table_patch_from_fragments(&prefix, &frags)))
}

/// [`add_offset_table`] for a file on disk, without holding it: when the instance needs a table,
/// writes the patch's head and then the original bytes from where it resumes to a temporary file
/// beside it, and renames that over the original. Returns the new length, or `None` when the file
/// was left as it is.
pub fn add_offset_table_to_file(path: &std::path::Path) -> std::io::Result<Option<u64>> {
    use std::io::{BufReader, BufWriter, Seek, SeekFrom, Write};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let Some(patch) = offset_table_patch_from_reader(&mut BufReader::with_capacity(64 << 10, &mut f), len)? else {
        return Ok(None);
    };
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".offset-table");
    let tmp = std::path::PathBuf::from(tmp);
    {
        let mut out = BufWriter::new(std::fs::File::create(&tmp)?);
        out.write_all(&patch.head)?;
        f.seek(SeekFrom::Start(patch.resume_at as u64))?;
        std::io::copy(&mut f, &mut out)?;
        out.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(Some(patch.new_len(len as usize) as u64))
}

/// `bot_limit`: the largest offset a BOT may hold (u32::MAX; tests lower it to reach the EOT path).
fn patch_with_limit(bytes: &[u8], bot_limit: u64) -> Option<OffsetTablePatch> {
    let first_item = offset_table_first_fragment(bytes)?;
    let mut walk = FragmentWalk::new(first_item as u64, bytes.len() as u64);
    while let Some((at, n)) = walk.want() {
        walk.feed(&bytes[at as usize..at as usize + n]);
    }
    let frags = walk.fragments()?;
    patch_parts(bytes, &frags, bot_limit)
}

fn patch_parts(prefix: &[u8], frags: &[FragmentInfo], bot_limit: u64) -> Option<OffsetTablePatch> {
    let h = scan_header(prefix)?;
    if h.frames < 2 || h.has_eot || h.bot_len != 0 || frags.is_empty() {
        return None;
    }
    let first_item = (h.bot_pos + 8) as u64;
    if frags[0].pos != first_item {
        return None;
    }
    // Frame starts, as indices into frags.
    let starts = shl_dicom_decode::syntax::frame_starts(&h.ts, frags.iter().map(|f| f.head), h.frames)?;
    let offsets: Vec<u64> = starts.iter().map(|&i| frags[i].pos - first_item).collect();
    let fits_32 = offsets.last().is_none_or(|&o| o <= bot_limit) && h.frames * 4 <= u32::MAX as usize;
    if fits_32 {
        let mut head = Vec::with_capacity(h.bot_pos + 8 + 4 * h.frames);
        head.extend_from_slice(&prefix[..h.bot_pos]);
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
    head.extend_from_slice(&prefix[..h.pixel_tag_pos]);
    for (tag, values) in [(EOT_TAG, offsets.clone()), (EOT_LENGTHS_TAG, frags.iter().map(|f| f.len as u64).collect())] {
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
                h.eot.iter().map(|&o| first_item + o as usize).collect()
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
        synthetic_ts("1.2.840.10008.1.2.4.50", frames, split, with_seq)
    }

    /// [`synthetic`] under transfer syntax `ts`; frames start with FF 0A (a JPEG XL codestream)
    /// under the JPEG XL syntaxes, else with SOI.
    pub(crate) fn synthetic_ts(ts: &str, frames: usize, split: &[usize], with_seq: bool) -> Vec<u8> {
        use crate::test_ds::{part10_meta, Ds, Enc};
        const SM: &str = "1.2.840.10008.5.1.4.1.1.77.1.6";
        let mut d = Ds::new(Enc::ExplicitLe);
        d.ui(0x0008, 0x0016, SM).ui(0x0008, 0x0018, "1.2.3.4.5.6").text(0x0008, 0x0060, b"CS", "SM");
        if with_seq {
            d.text(0x0008, 0x0070, b"LO", "x");
            // An undefined-length sequence with an undefined-length item, to exercise skipping.
            d.seq(0x0008, 0x1115, &[&|i: &mut Ds| {
                i.ui(0x0008, 0x1155, "1.2.3");
            }]);
        }
        d.text(0x0010, 0x0010, b"PN", "Test^Slide");
        d.ui(0x0020, 0x000D, "1.2.3.4").ui(0x0020, 0x000E, "1.2.3.4.1").text(0x0020, 0x0013, b"IS", "1");
        d.image(1, "MONOCHROME2", None, Some(&frames.to_string()), 8, 8, 8, 8, 0);
        let start = if ts.starts_with("1.2.840.10008.1.2.4.11") { [0xFF, 0x0A] } else { [0xFF, 0xD8] };
        let mut frags = Vec::new();
        for k in 0..frames {
            for f in 0..split[k % split.len()] {
                let mut v = if f == 0 { start.to_vec() } else { vec![0x11, 0x22] };
                v.extend((0..(10 + 7 * k + 3 * f)).map(|i| (i * 31 + k) as u8));
                if v.len() % 2 == 1 {
                    v.push(0);
                }
                frags.push(v);
            }
        }
        d.encapsulated(&[], &frags.iter().map(|v| v.as_slice()).collect::<Vec<_>>());
        part10_meta(ts, &[(0x0002, SM), (0x0003, "1.2.3.4.5.6")], &d.out, true)
    }

    /// A file meta element whose length runs past the end of the address space (on wasm32 and
    /// other 32-bit targets) is unreadable, not a panic.
    #[test]
    fn a_huge_meta_length_is_unreadable() {
        let mut b = synthetic(3, &[1], false);
        // (0002,0001) File Meta Information Version, OB: its 4-byte length follows the group length.
        let at = 132 + 12;
        assert_eq!(&b[at..at + 6], &[0x02, 0x00, 0x01, 0x00, b'O', b'B']);
        b[at + 8..at + 12].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
        assert_eq!(offset_table_status(&b), OffsetTableStatus::NotApplicable);
    }

    #[test]
    fn header_probe_distinguishes_incomplete_from_no_table_needed() {
        let missing = synthetic(7, &[1], true);
        let bot = add_offset_table(missing.clone()).0;
        let eot = patch_with_limit(&synthetic(4, &[1], true), 16).unwrap().apply(&synthetic(4, &[1], true));
        let single = synthetic(1, &[1], false);
        for (bytes, needs_table) in [(&missing, true), (&bot, false), (&eot, false), (&single, false)] {
            let end = scan_header(bytes).unwrap().bot_pos + 8;
            assert!(offset_table_probe(&bytes[..end - 1]).is_none());
            let probe = offset_table_probe(&bytes[..end]).expect("the BOT header is enough, without pixel bytes");
            assert_eq!(probe.first_fragment, needs_table.then_some(end));
        }
    }

    #[test]
    fn reader_patch_matches_in_memory_patch() {
        for (split, seq) in [(vec![1], false), (vec![1, 2, 3], true)] {
            let src = synthetic(7, &split, seq);
            let want = offset_table_patch(&src).unwrap();
            let got = offset_table_patch_from_reader(&mut std::io::Cursor::new(&src), src.len() as u64).unwrap().unwrap();
            assert_eq!((got.head, got.resume_at, got.frames, got.kind), (want.head, want.resume_at, want.frames, want.kind));
        }
        // An instance that already has a table, and a truncated one, give no patch.
        let (with_table, _) = add_offset_table(synthetic(7, &[1], false));
        assert!(offset_table_patch_from_reader(&mut std::io::Cursor::new(&with_table), with_table.len() as u64).unwrap().is_none());
        let src = synthetic(7, &[1], false);
        let cut = &src[..src.len() - 20];
        assert!(offset_table_patch_from_reader(&mut std::io::Cursor::new(cut), cut.len() as u64).unwrap().is_none());
    }

    #[test]
    fn file_rewrite_matches_in_memory_rewrite() {
        let dir = std::env::temp_dir().join(format!("shl-offset-table-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("slide.dcm");
        let src = synthetic(9, &[1, 2], true);
        std::fs::write(&path, &src).unwrap();
        let (want, changed) = add_offset_table(src);
        assert!(changed);
        assert_eq!(add_offset_table_to_file(&path).unwrap(), Some(want.len() as u64));
        assert_eq!(std::fs::read(&path).unwrap(), want);
        // A second pass finds the table and leaves the file alone.
        assert_eq!(add_offset_table_to_file(&path).unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
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
    fn jpeg_xl_frames_over_several_fragments_get_a_table() {
        let src = synthetic_ts("1.2.840.10008.1.2.4.112", 5, &[1, 2, 3], false);
        let (out, changed) = add_offset_table(src.clone());
        assert!(changed);
        let frames = frames_of(&out).unwrap();
        assert_eq!(frames.len(), 5);
        assert!(frames.iter().all(|f| f.starts_with(&[0xFF, 0x0A])));
        assert_eq!(frames_of(&src).unwrap(), frames);
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
