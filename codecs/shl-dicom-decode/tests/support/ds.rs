//! The one builder of synthetic DICOM for Rust tests. Test files include it by path
//! (`#[path = ".../shl-dicom-decode/tests/support/ds.rs"] mod ds;`): this crate's tests, the
//! transcoder's, and shl-dicom-core's.
#![allow(dead_code)]

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Enc {
    ExplicitLe,
    ImplicitLe,
    ExplicitBe,
}

/// A data set being written, element by element, in one encoding.
pub struct Ds {
    pub enc: Enc,
    pub out: Vec<u8>,
}

impl Ds {
    pub fn new(enc: Enc) -> Self {
        Self { enc, out: Vec::new() }
    }
    pub fn u16(&mut self, v: u16) {
        let b = if self.enc == Enc::ExplicitBe { v.to_be_bytes() } else { v.to_le_bytes() };
        self.out.extend_from_slice(&b);
    }
    pub fn u32(&mut self, v: u32) {
        let b = if self.enc == Enc::ExplicitBe { v.to_be_bytes() } else { v.to_le_bytes() };
        self.out.extend_from_slice(&b);
    }
    /// Bytes as they are.
    pub fn raw(&mut self, b: &[u8]) -> &mut Self {
        self.out.extend_from_slice(b);
        self
    }
    /// An element header: tag, then (explicit VR) the VR and a 2- or 4-byte length.
    fn header(&mut self, g: u16, e: u16, vr: &[u8; 2], len: u32) {
        self.u16(g);
        self.u16(e);
        if self.enc == Enc::ImplicitLe {
            self.u32(len);
        } else {
            self.out.extend_from_slice(vr);
            if matches!(vr, b"OB" | b"OW" | b"OF" | b"OD" | b"OL" | b"SQ" | b"UN" | b"OV" | b"UT") {
                self.out.extend_from_slice(&[0, 0]);
                self.u32(len);
            } else {
                self.u16(len as u16);
            }
        }
    }
    pub fn elem(&mut self, g: u16, e: u16, vr: &[u8; 2], value: &[u8]) -> &mut Self {
        self.header(g, e, vr, value.len() as u32);
        self.out.extend_from_slice(value);
        self
    }
    pub fn us(&mut self, g: u16, e: u16, v: u16) -> &mut Self {
        let b = if self.enc == Enc::ExplicitBe { v.to_be_bytes() } else { v.to_le_bytes() };
        self.elem(g, e, b"US", &b)
    }
    /// A text value, padded to even length with a space.
    pub fn text(&mut self, g: u16, e: u16, vr: &[u8; 2], s: &str) -> &mut Self {
        let mut v = s.as_bytes().to_vec();
        if v.len() % 2 == 1 {
            v.push(b' ');
        }
        self.elem(g, e, vr, &v)
    }
    /// A UI value, padded to even length with NUL.
    pub fn ui(&mut self, g: u16, e: u16, uid: &str) -> &mut Self {
        let mut v = uid.as_bytes().to_vec();
        if v.len() % 2 == 1 {
            v.push(0);
        }
        self.elem(g, e, b"UI", &v)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn image(&mut self, spp: u16, photometric: &str, planar: Option<u16>, frames: Option<&str>, rows: u16, cols: u16, ba: u16, bs: u16, pr: u16) -> &mut Self {
        self.us(0x0028, 0x0002, spp);
        self.text(0x0028, 0x0004, b"CS", photometric);
        if let Some(p) = planar {
            self.us(0x0028, 0x0006, p);
        }
        if let Some(f) = frames {
            self.text(0x0028, 0x0008, b"IS", f);
        }
        self.us(0x0028, 0x0010, rows);
        self.us(0x0028, 0x0011, cols);
        self.us(0x0028, 0x0100, ba);
        self.us(0x0028, 0x0101, bs);
        self.us(0x0028, 0x0103, pr)
    }
    /// A sequence of undefined length whose items (also of undefined length) are written by `items`,
    /// one call per item.
    pub fn seq(&mut self, g: u16, e: u16, items: &[&dyn Fn(&mut Ds)]) -> &mut Self {
        self.header(g, e, b"SQ", 0xFFFF_FFFF);
        for item in items {
            self.u16(0xFFFE);
            self.u16(0xE000);
            self.u32(0xFFFF_FFFF);
            item(self);
            self.u16(0xFFFE);
            self.u16(0xE00D);
            self.u32(0);
        }
        self.u16(0xFFFE);
        self.u16(0xE0DD);
        self.u32(0);
        self
    }
    /// A sequence of defined length holding one defined-length item per entry of `items` (each an
    /// item's encoded elements).
    pub fn seq_defined(&mut self, g: u16, e: u16, items: &[&[u8]]) -> &mut Self {
        let len: usize = items.iter().map(|i| 8 + i.len()).sum();
        self.header(g, e, b"SQ", len as u32);
        for item in items {
            self.u16(0xFFFE);
            self.u16(0xE000);
            self.u32(item.len() as u32);
            self.out.extend_from_slice(item);
        }
        self
    }
    /// Encapsulated Pixel Data: a Basic Offset Table item holding `bot`, then `fragments`.
    pub fn encapsulated(&mut self, bot: &[u32], fragments: &[&[u8]]) -> &mut Self {
        self.u16(0x7FE0);
        self.u16(0x0010);
        if self.enc != Enc::ImplicitLe {
            self.out.extend_from_slice(b"OB\0\0");
        }
        self.u32(0xFFFF_FFFF);
        let item = |ds: &mut Ds, data: &[u8]| {
            ds.u16(0xFFFE);
            ds.u16(0xE000);
            ds.u32(data.len() as u32);
            ds.out.extend_from_slice(data);
        };
        let bot_bytes: Vec<u8> = bot.iter().flat_map(|v| v.to_le_bytes()).collect();
        item(self, &bot_bytes);
        for f in fragments {
            item(self, f);
        }
        self.u16(0xFFFE);
        self.u16(0xE0DD);
        self.u32(0);
        self
    }
}

/// A Part 10 file: (optional) preamble and DICM, file meta with Transfer Syntax UID `ts`, then
/// `dataset`.
pub fn part10(ts: &str, dataset: &[u8], preamble: bool) -> Vec<u8> {
    part10_meta(ts, &[], dataset, preamble)
}

/// [`part10`] with more UI elements of the file meta, as (element, UID): (0002,0002) Media Storage
/// SOP Class UID, (0002,0003) its Instance UID, (0002,0012) Implementation Class UID.
pub fn part10_meta(ts: &str, extra: &[(u16, &str)], dataset: &[u8], preamble: bool) -> Vec<u8> {
    let mut f = Vec::new();
    if preamble {
        f.extend_from_slice(&[0u8; 128]);
        f.extend_from_slice(b"DICM");
    }
    let mut ui: Vec<(u16, &str)> = extra.to_vec();
    ui.push((0x0010, ts));
    ui.sort_by_key(|x| x.0);
    let mut meta = Ds::new(Enc::ExplicitLe);
    meta.elem(0x0002, 0x0001, b"OB", &[0, 1]);
    for (e, uid) in ui {
        meta.ui(0x0002, e, uid);
    }
    let mut group_len = Ds::new(Enc::ExplicitLe);
    group_len.elem(0x0002, 0x0000, b"UL", &(meta.out.len() as u32).to_le_bytes());
    f.extend_from_slice(&group_len.out);
    f.extend_from_slice(&meta.out);
    f.extend_from_slice(dataset);
    f
}
