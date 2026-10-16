//! JPEG reconstruction (ISO/IEC 18181-2 Annex B): the `jbrd` box describes everything of the
//! original JPEG file except its DCT coefficients, which come from the codestream's VarDCT
//! frame. The writer follows libjxl's dec_jpeg_data_writer.cc so the output is byte-identical.

use crate::bits::{bits, bits_offset, val, BitReader};
use crate::error::{invalid, Error, Result};

#[rustfmt::skip]
pub const NATURAL_ORDER: [usize; 80] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
];

const ICC_TAG: &[u8; 12] = b"ICC_PROFILE\0";
const EXIF_TAG: &[u8; 6] = b"Exif\0\0";
const XMP_TAG: &[u8; 29] = b"http://ns.adobe.com/xap/1.0/\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppType {
    Unknown,
    Icc,
    Exif,
    Xmp,
}

#[derive(Clone, Debug)]
pub struct QuantTable {
    pub values: [i32; 64],
    pub precision: u32,
    pub index: u32,
    pub is_last: bool,
}

#[derive(Clone, Debug)]
pub struct HuffmanCode {
    pub counts: [u32; 17],
    pub values: [u32; 257],
    pub slot_id: u32,
    pub is_last: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ScanComponent {
    pub comp_idx: u32,
    pub dc_tbl_idx: u32,
    pub ac_tbl_idx: u32,
}

#[derive(Clone, Debug, Default)]
pub struct ScanInfo {
    pub ss: u32,
    pub se: u32,
    pub ah: u32,
    pub al: u32,
    pub num_components: u32,
    pub components: [ScanComponent; 4],
    pub reset_points: Vec<u32>,
    /// (block index, number of extra zero runs).
    pub extra_zero_runs: Vec<(u32, u32)>,
}

#[derive(Clone, Debug, Default)]
pub struct Component {
    pub id: u32,
    pub h_samp: u32,
    pub v_samp: u32,
    pub quant_idx: u32,
    pub width_in_blocks: usize,
    pub height_in_blocks: usize,
    /// 64 coefficients per block, natural (row-major) order inside each block.
    pub coeffs: Vec<i16>,
}

#[derive(Clone, Debug, Default)]
pub struct JpegData {
    pub width: u32,
    pub height: u32,
    pub restart_interval: u32,
    pub app_data: Vec<Vec<u8>>,
    pub app_type: Vec<AppType>,
    pub com_data: Vec<Vec<u8>>,
    pub quant: Vec<QuantTable>,
    pub huffman: Vec<HuffmanCode>,
    pub components: Vec<Component>,
    pub scans: Vec<ScanInfo>,
    pub marker_order: Vec<u8>,
    pub inter_marker_data: Vec<Vec<u8>>,
    pub tail_data: Vec<u8>,
    pub has_zero_padding_bit: bool,
    pub padding_bits: Vec<u8>,
}

/// Parses the `jbrd` box. Brotli-compressed parts are decompressed with `brotli`.
pub fn parse_jbrd(data: &[u8], brotli: impl Fn(&[u8], usize) -> Result<(Vec<u8>, usize)>) -> Result<JpegData> {
    let mut br = BitReader::new(data);
    let mut j = JpegData::default();
    let is_gray = br.bit();
    j.components = vec![Component::default(); if is_gray { 1 } else { 3 }];
    let (mut napp, mut ncom, mut nscan, mut ninter, mut has_dri) = (0usize, 0usize, 0usize, 0usize, false);
    loop {
        let m = (br.read(6) + 0xC0) as u8;
        if m & 0xF0 == 0xE0 {
            napp += 1;
        }
        match m {
            0xFE => ncom += 1,
            0xDA => nscan += 1,
            0xFF => ninter += 1,
            0xDD => has_dri = true,
            _ => {}
        }
        j.marker_order.push(m);
        if j.marker_order.len() > 16384 {
            return invalid("too many JPEG markers");
        }
        if br.overrun() {
            return invalid("truncated jbrd box");
        }
        if m == 0xD9 {
            break;
        }
    }
    if nscan == 0 {
        return invalid("JPEG without scans");
    }
    for _ in 0..napp {
        let t = match br.u32([val(0), val(1), bits_offset(1, 2), bits_offset(2, 4)]) {
            0 => AppType::Unknown,
            1 => AppType::Icc,
            2 => AppType::Exif,
            3 => AppType::Xmp,
            _ => return invalid("JPEG APP marker type"),
        };
        let len = br.read(16) as usize + 1;
        if len < 3 {
            return invalid("JPEG marker size");
        }
        j.app_type.push(t);
        j.app_data.push(vec![0; len]);
    }
    for _ in 0..ncom {
        let len = br.read(16) as usize + 1;
        if len < 3 {
            return invalid("JPEG marker size");
        }
        j.com_data.push(vec![0; len]);
    }
    let nq = br.u32([val(1), val(2), val(3), val(4)]) as usize;
    if nq == 4 {
        return invalid("JPEG quantisation table count");
    }
    for i in 0..nq {
        let precision = br.read(1);
        let index = br.read(2);
        let is_last = br.bit();
        let _ = i;
        j.quant.push(QuantTable { values: [0; 64], precision, index, is_last });
    }
    let ctype = br.read(2);
    let ncomp = match ctype {
        0 => 1,
        1 | 2 => 3,
        _ => {
            let n = br.u32([val(1), val(2), val(3), val(4)]) as usize;
            if n != 1 && n != 3 {
                return invalid("JPEG component count");
            }
            n
        }
    };
    j.components = vec![Component::default(); ncomp];
    match ctype {
        0 => j.components[0].id = 1,
        1 => {
            for (i, c) in j.components.iter_mut().enumerate() {
                c.id = i as u32 + 1;
            }
        }
        2 => {
            for (c, id) in j.components.iter_mut().zip([b'R', b'G', b'B']) {
                c.id = u32::from(id);
            }
        }
        _ => {
            for c in j.components.iter_mut() {
                c.id = br.read(8);
            }
        }
    }
    let mut used_tables = 0u32;
    for c in j.components.iter_mut() {
        c.quant_idx = br.read(2);
        if c.quant_idx as usize >= j.quant.len() {
            return invalid("JPEG component quantisation table");
        }
        used_tables |= 1 << c.quant_idx;
    }
    if used_tables & 1 == 0 && !j.quant.is_empty() {
        return invalid("first JPEG quantisation table unused");
    }
    let nh = br.u32([val(4), bits_offset(3, 2), bits_offset(4, 10), bits_offset(6, 26)]) as usize;
    for _ in 0..nh {
        let is_ac = br.bit();
        let id = br.read(2);
        let is_last = br.bit();
        let mut hc = HuffmanCode { counts: [0; 17], values: [0; 257], slot_id: (u32::from(is_ac) << 4) | id, is_last };
        let mut num_symbols = 0usize;
        for i in 0..=16 {
            hc.counts[i] = br.u32([val(0), val(1), bits_offset(3, 2), bits(8)]);
            num_symbols += hc.counts[i] as usize;
        }
        if br.overrun() {
            return invalid("truncated jbrd box");
        }
        if num_symbols == 0 {
            j.huffman.push(hc);
            continue;
        }
        if num_symbols > 257 {
            return invalid("JPEG Huffman code too large");
        }
        let mut slots = [0u64; 5];
        for i in 0..num_symbols {
            let v = br.u32([bits(2), bits_offset(2, 4), bits_offset(4, 8), bits_offset(8, 1)]);
            if v > 256 {
                return invalid("JPEG Huffman symbol");
            }
            hc.values[i] = v;
            slots[(v >> 6) as usize] |= 1u64 << (v & 63);
        }
        if hc.values[num_symbols - 1] != 256 {
            return invalid("JPEG Huffman code without its end symbol");
        }
        if slots[4] != 1 {
            return invalid("JPEG Huffman symbols");
        }
        let distinct = 1 + slots[..4].iter().map(|s| s.count_ones() as usize).sum::<usize>();
        if distinct != num_symbols {
            return invalid("duplicate JPEG Huffman symbols");
        }
        if !is_ac && ((slots[0] >> 12) | slots[1] | slots[2] | slots[3]) != 0 {
            return invalid("JPEG DC Huffman symbols out of range");
        }
        j.huffman.push(hc);
    }
    for _ in 0..nscan {
        let mut s = ScanInfo { num_components: br.u32([val(1), val(2), val(3), val(4)]), ..ScanInfo::default() };
        if s.num_components >= 4 {
            return invalid("JPEG scan component count");
        }
        s.ss = br.read(6);
        s.se = br.read(6);
        s.al = br.read(4);
        s.ah = br.read(4);
        for i in 0..s.num_components as usize {
            let comp_idx = br.read(2);
            if comp_idx as usize >= j.components.len() {
                return invalid("JPEG scan component");
            }
            let ac_tbl_idx = br.read(2);
            let dc_tbl_idx = br.read(2);
            s.components[i] = ScanComponent { comp_idx, dc_tbl_idx, ac_tbl_idx };
        }
        br.u32([val(0), val(1), val(2), bits_offset(3, 3)]);
        j.scans.push(s);
    }
    if has_dri {
        j.restart_interval = br.read(16);
    }
    for s in j.scans.iter_mut() {
        let n = br.u32([val(0), bits_offset(2, 1), bits_offset(4, 4), bits_offset(16, 20)]) as usize;
        let mut last: i64 = -1;
        for _ in 0..n {
            let d = br.u32([val(0), bits_offset(3, 1), bits_offset(5, 9), bits_offset(28, 41)]);
            let b = i64::from(d) + last + 1;
            if b >= 3 << 26 {
                return invalid("JPEG reset point");
            }
            s.reset_points.push(b as u32);
            last = b;
            if br.overrun() {
                return invalid("truncated jbrd box");
            }
        }
        let n = br.u32([val(0), bits_offset(2, 1), bits_offset(4, 4), bits_offset(16, 20)]) as usize;
        let mut last: i64 = -1;
        for _ in 0..n {
            let runs = br.u32([val(1), bits_offset(2, 2), bits_offset(4, 5), bits_offset(8, 20)]);
            let d = br.u32([val(0), bits_offset(3, 1), bits_offset(5, 9), bits_offset(28, 41)]);
            let b = i64::from(d) + last + 1;
            if runs > 4 {
                return invalid("JPEG extra zero runs");
            }
            if b > 3 << 26 {
                return invalid("JPEG extra zero run block");
            }
            s.extra_zero_runs.push((b as u32, runs));
            last = b;
            if br.overrun() {
                return invalid("truncated jbrd box");
            }
        }
    }
    let mut inter_sizes = Vec::with_capacity(ninter);
    for _ in 0..ninter {
        inter_sizes.push(br.read(16) as usize);
    }
    let tail_len = br.u32([val(0), bits_offset(8, 1), bits_offset(16, 257), bits_offset(22, 65793)]) as usize;
    j.has_zero_padding_bit = br.bit();
    if j.has_zero_padding_bit {
        let nbit = br.read(24) as u64;
        if nbit > br.total_bits().saturating_sub(br.bits_consumed()) {
            return invalid("JPEG padding bits beyond the data");
        }
        for _ in 0..nbit {
            j.padding_bits.push(u8::from(br.bit()));
        }
    }
    br.check_end()?;
    // Huffman tables must be defined before the scans that use them.
    {
        let (mut dht, mut scan_i, mut prog) = (0usize, 0usize, false);
        let (mut ac_ok, mut dc_ok) = ([false; 4], [false; 4]);
        for &m in &j.marker_order {
            if m == 0xC2 {
                prog = true;
            } else if m == 0xC4 {
                while dht < j.huffman.len() {
                    let h = &j.huffman[dht];
                    dht += 1;
                    let idx = (h.slot_id & 0xF) as usize;
                    if h.slot_id & 0x10 != 0 {
                        ac_ok[idx] = true;
                    } else {
                        dc_ok[idx] = true;
                    }
                    if h.is_last {
                        break;
                    }
                }
            } else if m == 0xDA {
                let si = &j.scans[scan_i];
                scan_i += 1;
                for c in &si.components[..si.num_components as usize] {
                    if (!prog || si.ss == 0) && !dc_ok[c.dc_tbl_idx as usize] {
                        return invalid("JPEG DC Huffman table used before it is defined");
                    }
                    if (!prog || si.ss != 0 || si.se != 0) && !ac_ok[c.ac_tbl_idx as usize] {
                        return invalid("JPEG AC Huffman table used before it is defined");
                    }
                }
            }
        }
    }
    br.jump_to_byte_boundary()?;
    let rest = &data[br.byte_pos().min(data.len())..];
    // The remaining data is one brotli stream holding, in order: unknown APP markers, COM
    // markers, inter-marker data and the tail data.
    let mut total = 0usize;
    for (a, t) in j.app_data.iter().zip(&j.app_type) {
        if *t == AppType::Unknown {
            total += a.len();
        }
    }
    total += j.com_data.iter().map(|c| c.len()).sum::<usize>();
    total += inter_sizes.iter().sum::<usize>() + tail_len;
    let (plain, used) = brotli(rest, total)?;
    if plain.len() != total {
        return invalid("JPEG reconstruction data has the wrong size");
    }
    if used != rest.len() {
        return invalid("data after the JPEG reconstruction brotli stream");
    }
    let mut pos = 0usize;
    let mut take = |n: usize| -> Vec<u8> {
        let v = plain[pos..pos + n].to_vec();
        pos += n;
        v
    };
    let mut num_icc = 0u8;
    for i in 0..j.app_data.len() {
        let len = j.app_data[i].len();
        match j.app_type[i] {
            AppType::Unknown => {
                let m = take(len);
                if usize::from(m[1]) * 256 + usize::from(m[2]) + 1 != len {
                    return invalid("JPEG marker size");
                }
                j.app_data[i] = m;
            }
            t => {
                let m = &mut j.app_data[i];
                let sz = len - 1;
                m[1] = (sz >> 8) as u8;
                m[2] = (sz & 0xFF) as u8;
                if t == AppType::Icc {
                    if len < 17 {
                        return invalid("JPEG ICC marker too short");
                    }
                    m[0] = 0xE2;
                    m[3..15].copy_from_slice(ICC_TAG);
                    num_icc = num_icc.wrapping_add(1);
                    m[15] = num_icc;
                }
            }
        }
    }
    for i in 0..j.app_data.len() {
        let m = &mut j.app_data[i];
        match j.app_type[i] {
            AppType::Icc => m[16] = num_icc,
            AppType::Exif => {
                if m.len() < 3 + EXIF_TAG.len() {
                    return invalid("JPEG Exif marker size");
                }
                m[0] = 0xE1;
                m[3..9].copy_from_slice(EXIF_TAG);
            }
            AppType::Xmp => {
                if m.len() < 3 + XMP_TAG.len() {
                    return invalid("JPEG XMP marker size");
                }
                m[0] = 0xE1;
                m[3..32].copy_from_slice(XMP_TAG);
            }
            AppType::Unknown => {}
        }
    }
    for c in j.com_data.iter_mut() {
        let len = c.len();
        let m = take(len);
        if usize::from(m[1]) * 256 + usize::from(m[2]) + 1 != len {
            return invalid("JPEG COM marker size");
        }
        *c = m;
    }
    for &n in &inter_sizes {
        let m = take(n);
        j.inter_marker_data.push(m);
    }
    j.tail_data = take(tail_len);
    Ok(j)
}

impl JpegData {
    /// Copies an ICC profile into the ICC APP markers (they hold it in order).
    pub fn set_icc(&mut self, icc: &[u8]) -> Result<()> {
        let mut pos = 0usize;
        for i in 0..self.app_data.len() {
            if self.app_type[i] != AppType::Icc {
                continue;
            }
            let len = self.app_data[i].len() - 17;
            if pos + len > icc.len() {
                return invalid("ICC profile shorter than its JPEG markers");
            }
            self.app_data[i][17..].copy_from_slice(&icc[pos..pos + len]);
            pos += len;
        }
        if pos != icc.len() && pos != 0 {
            return invalid("ICC profile longer than its JPEG markers");
        }
        Ok(())
    }

    /// Fills the Exif marker from an `Exif` box (whose first 4 bytes are the TIFF offset).
    pub fn set_exif(&mut self, b: &[u8]) -> Result<()> {
        for i in 0..self.app_data.len() {
            if self.app_type[i] == AppType::Exif {
                let m = &mut self.app_data[i];
                if b.len() < 4 || m.len() != b.len() + 3 + EXIF_TAG.len() - 4 {
                    return invalid("Exif box does not match its JPEG marker");
                }
                m[9..].copy_from_slice(&b[4..]);
                return Ok(());
            }
        }
        invalid("Exif box without an Exif marker")
    }

    pub fn set_xmp(&mut self, b: &[u8]) -> Result<()> {
        for i in 0..self.app_data.len() {
            if self.app_type[i] == AppType::Xmp {
                let m = &mut self.app_data[i];
                if m.len() != b.len() + 3 + XMP_TAG.len() {
                    return invalid("XMP box does not match its JPEG marker");
                }
                m[32..].copy_from_slice(b);
                return Ok(());
            }
        }
        invalid("XMP box without an XMP marker")
    }

    pub fn has_exif(&self) -> bool {
        self.app_type.contains(&AppType::Exif)
    }
    pub fn has_xmp(&self) -> bool {
        self.app_type.contains(&AppType::Xmp)
    }
}

// ---- Writer ----

struct HuffTable {
    depth: [i8; 256],
    code: [u16; 256],
    initialized: bool,
}

impl Default for HuffTable {
    fn default() -> Self {
        HuffTable { depth: [0; 256], code: [0; 256], initialized: false }
    }
}

fn build_huff(h: &HuffmanCode, t: &mut HuffTable) -> bool {
    let mut huff_size = [0u32; 258];
    let mut p = 0usize;
    for l in 1..=16usize {
        let mut i = h.counts[l];
        if p + i as usize > 257 {
            return false;
        }
        while i > 0 {
            huff_size[p] = l as u32;
            p += 1;
            i -= 1;
        }
    }
    if p == 0 {
        return true;
    }
    let last_p = p - 1;
    huff_size[last_p] = 0;
    let mut huff_code = [0i32; 257];
    let mut code = 0i32;
    let mut si = huff_size[0];
    p = 0;
    while huff_size[p] != 0 {
        while huff_size[p] == si {
            huff_code[p] = code;
            p += 1;
            code += 1;
        }
        code <<= 1;
        si += 1;
        if si > 32 {
            return false;
        }
    }
    for p in 0..last_p {
        let i = h.values[p] as usize;
        if i >= 256 {
            return false;
        }
        t.depth[i] = huff_size[p] as i8;
        t.code[i] = huff_code[p] as u16;
    }
    true
}

struct BitWriter {
    out: Vec<u8>,
    put_buffer: u64,
    put_bits: i32,
    healthy: bool,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter { out: Vec::new(), put_buffer: 0, put_bits: 64, healthy: true }
    }

    #[inline(always)]
    fn emit_byte(&mut self, b: u8) {
        self.out.push(b);
        if b == 0xFF {
            self.out.push(0);
        }
    }

    fn discharge(&mut self, bits: u64) {
        self.put_buffer |= bits.checked_shr((-self.put_bits) as u32).unwrap_or(0);
        for k in (0..8).rev() {
            self.emit_byte((self.put_buffer >> (8 * k)) as u8);
        }
        self.put_bits += 64;
        self.put_buffer = if self.put_bits >= 64 { 0 } else { bits << self.put_bits as u32 };
    }

    #[inline(always)]
    fn write(&mut self, nbits: i32, bits: u64) {
        if nbits <= 0 {
            return;
        }
        self.put_bits -= nbits;
        if self.put_bits < 0 {
            if nbits > 64 {
                self.put_bits += nbits;
                self.healthy = false;
            } else {
                self.discharge(bits);
            }
        } else {
            self.put_buffer |= bits << self.put_bits as u32;
        }
    }

    fn symbol(&mut self, sym: usize, t: &HuffTable) {
        let s = sym & 0xFF;
        self.write(i32::from(t.depth[s]), u64::from(t.code[s]));
    }

    fn symbol_bits(&mut self, sym: usize, t: &HuffTable, nbits: i32, bits: u64) {
        let s = sym & 0xFF;
        self.write(nbits + i32::from(t.depth[s]), bits | (u64::from(t.code[s]) << nbits));
    }

    fn marker(&mut self, m: u8) {
        self.out.push(0xFF);
        self.out.push(m);
    }

    fn jump_to_byte_boundary(&mut self, pad: &mut Option<(&[u8], usize)>) -> bool {
        let mut n_bits = (self.put_bits & 7) as u32;
        let mut dangling = 0u8;
        let pad_pattern: u8 = match pad {
            None => ((1u32 << n_bits) - 1) as u8,
            Some((bits, pos)) => {
                let mut p = 0u8;
                while n_bits > 0 {
                    n_bits -= 1;
                    p <<= 1;
                    let Some(&b) = bits.get(*pos) else { return false };
                    *pos += 1;
                    dangling |= b;
                    p |= b;
                }
                p
            }
        };
        if dangling & !1 != 0 {
            return false;
        }
        while self.put_bits <= 56 {
            let c = (self.put_buffer >> 56) as u8;
            self.emit_byte(c);
            self.put_buffer <<= 8;
            self.put_bits += 8;
        }
        if self.put_bits < 64 {
            let pad_mask = (0xFFu32 >> (64 - self.put_bits)) as u8;
            let c = ((self.put_buffer >> 56) as u8 & !pad_mask) | pad_pattern;
            self.emit_byte(c);
        }
        self.put_buffer = 0;
        self.put_bits = 64;
        true
    }
}

struct CodingState {
    eob_run: u32,
    cur_ac: usize,
    refinement_bits: Vec<u16>,
    refinement_bits_count: usize,
}

fn floor_log2(v: u32) -> i32 {
    31 - v.leading_zeros() as i32
}

impl CodingState {
    fn flush(&mut self, bw: &mut BitWriter, ac: &[HuffTable]) {
        if self.eob_run > 0 {
            let nbits = floor_log2(self.eob_run);
            let symbol = (nbits as usize) << 4;
            bw.symbol(symbol, &ac[self.cur_ac]);
            if nbits > 0 {
                bw.write(nbits, u64::from(self.eob_run & ((1 << nbits) - 1)));
            }
            self.eob_run = 0;
        }
        let num_words = self.refinement_bits_count >> 4;
        for i in 0..num_words {
            bw.write(16, u64::from(self.refinement_bits[i]));
        }
        let tail = self.refinement_bits_count & 0xF;
        if tail != 0 {
            if let Some(&last) = self.refinement_bits.last() {
                bw.write(tail as i32, u64::from(last));
            }
        }
        self.refinement_bits.clear();
        self.refinement_bits_count = 0;
    }

    fn buffer_eob(&mut self, ac_idx: usize, new_bits: &[u8], bw: &mut BitWriter, ac: &[HuffTable]) {
        if self.eob_run == 0 {
            self.cur_ac = ac_idx;
        }
        self.eob_run += 1;
        let mut count = new_bits.len();
        if count > 0 {
            let mut nb: u64 = 0;
            for &b in new_bits {
                nb = (nb << 1) | u64::from(b);
            }
            let tail = self.refinement_bits_count & 0xF;
            if tail != 0 {
                let stuff = (16 - tail).min(count);
                let sb = ((nb >> (count - stuff)) & ((1u64 << stuff) - 1)) as u16;
                if let Some(last) = self.refinement_bits.last_mut() {
                    *last = (*last << stuff) | sb;
                }
                count -= stuff;
                self.refinement_bits_count += stuff;
            }
            while count >= 16 {
                self.refinement_bits.push((nb >> (count - 16)) as u16);
                count -= 16;
                self.refinement_bits_count += 16;
            }
            if count > 0 {
                self.refinement_bits.push((nb & ((1u64 << count) - 1)) as u16);
                self.refinement_bits_count += count;
            }
        }
        if self.eob_run == 0x7FFF {
            self.flush(bw, ac);
        }
    }
}

fn encode_block_sequential(c: &[i16], dc: &HuffTable, ac: &HuffTable, zero_runs: u32, last_dc: &mut i16, bw: &mut BitWriter) -> bool {
    let mut temp2 = c[0];
    let mut temp = temp2.wrapping_sub(*last_dc);
    *last_dc = temp2;
    temp2 = temp >> 15;
    temp = temp.wrapping_add(temp2);
    temp2 ^= temp;
    let dc_nbits = if temp2 == 0 { 0 } else { floor_log2(temp2 as u16 as u32) + 1 };
    if dc_nbits > 16 || temp2 < 0 {
        return false;
    }
    bw.symbol(dc_nbits as usize, dc);
    if dc_nbits > 0 {
        bw.write(dc_nbits, u64::from(temp as u16 as u32 & ((1u32 << dc_nbits) - 1)));
    }
    let mut r: i32 = 0;
    let mut litmus: i16 = 0;
    for &nat in NATURAL_ORDER.iter().take(64).skip(1) {
        let mut temp = c[nat];
        if temp == 0 {
            r += 1;
        } else {
            let mut temp2 = temp >> 15;
            temp = temp.wrapping_add(temp2);
            temp2 ^= temp;
            if r > 15 {
                bw.symbol(0xF0, ac);
                r -= 16;
                if r > 15 {
                    bw.symbol(0xF0, ac);
                    r -= 16;
                }
                if r > 15 {
                    bw.symbol(0xF0, ac);
                    r -= 16;
                }
            }
            litmus |= temp2;
            let ac_nbits = floor_log2(u32::from(temp2 as u16)) + 1;
            let symbol = ((r as usize) << 4) + ac_nbits as usize;
            bw.symbol_bits(symbol, ac, ac_nbits, u64::from(temp as u16 as u32 & ((1u32 << ac_nbits) - 1)));
            r = 0;
        }
    }
    for _ in 0..zero_runs {
        bw.symbol(0xF0, ac);
        r -= 16;
    }
    if r > 0 {
        bw.symbol(0, ac);
    }
    litmus >= 0
}

#[allow(clippy::too_many_arguments)]
fn encode_block_progressive(
    c: &[i16],
    dc: &HuffTable,
    ac_idx: usize,
    acs: &[HuffTable],
    mut ss: i32,
    se: i32,
    al: u32,
    zero_runs: u32,
    st: &mut CodingState,
    last_dc: &mut i16,
    bw: &mut BitWriter,
) -> bool {
    let ac = &acs[ac_idx];
    let eob_run_allowed = ss > 0;
    if ss == 0 {
        let t2 = c[0] >> al;
        let mut temp = t2.wrapping_sub(*last_dc);
        *last_dc = t2;
        let mut temp2 = temp;
        if temp < 0 {
            temp = temp.wrapping_neg();
            if temp < 0 {
                return false;
            }
            temp2 = temp2.wrapping_sub(1);
        }
        let nbits = if temp == 0 { 0 } else { floor_log2(temp as u32) + 1 };
        bw.symbol(nbits as usize, dc);
        if nbits > 0 {
            bw.write(nbits, u64::from(temp2 as u16 as u32 & ((1u32 << nbits) - 1)));
        }
        ss += 1;
    }
    if ss > se {
        return true;
    }
    let mut r = 0i32;
    for k in ss..=se {
        let mut temp = c[NATURAL_ORDER[k as usize]];
        if temp == 0 {
            r += 1;
            continue;
        }
        let temp2;
        if temp < 0 {
            temp = temp.wrapping_neg();
            if temp < 0 {
                return false;
            }
            temp >>= al;
            temp2 = !temp;
        } else {
            temp >>= al;
            temp2 = temp;
        }
        if temp == 0 {
            r += 1;
            continue;
        }
        st.flush(bw, acs);
        while r > 15 {
            bw.symbol(0xF0, ac);
            r -= 16;
        }
        let nbits = floor_log2(temp as u32) + 1;
        let symbol = ((r as usize) << 4) + nbits as usize;
        bw.symbol(symbol, ac);
        bw.write(nbits, u64::from(temp2 as u16 as u32 & ((1u32 << nbits) - 1)));
        r = 0;
    }
    if zero_runs > 0 {
        st.flush(bw, acs);
        for _ in 0..zero_runs {
            bw.symbol(0xF0, ac);
            r -= 16;
        }
    }
    if r > 0 {
        st.buffer_eob(ac_idx, &[], bw, acs);
        if !eob_run_allowed {
            st.flush(bw, acs);
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn encode_refinement(c: &[i16], ac_idx: usize, acs: &[HuffTable], mut ss: i32, se: i32, al: u32, st: &mut CodingState, bw: &mut BitWriter) -> bool {
    let ac = &acs[ac_idx];
    let eob_run_allowed = ss > 0;
    if ss == 0 {
        bw.write(1, u64::from(((c[0] >> al) & 1) as u16));
        ss += 1;
    }
    if ss > se {
        return true;
    }
    let mut abs_values = [0i32; 64];
    let mut eob = 0i32;
    for k in ss..=se {
        let a = i32::from(c[NATURAL_ORDER[k as usize]]).abs() as u16 as i16;
        abs_values[k as usize] = i32::from(a) >> al;
        if abs_values[k as usize] == 1 {
            eob = k;
        }
    }
    let mut r = 0i32;
    let mut rb = [0u8; 64];
    let mut rbc = 0usize;
    for k in ss..=se {
        let av = abs_values[k as usize];
        if av == 0 {
            r += 1;
            continue;
        }
        while r > 15 && k <= eob {
            st.flush(bw, acs);
            bw.symbol(0xF0, ac);
            r -= 16;
            for &b in &rb[..rbc] {
                bw.write(1, u64::from(b));
            }
            rbc = 0;
        }
        if av > 1 {
            rb[rbc] = (av & 1) as u8;
            rbc += 1;
            continue;
        }
        st.flush(bw, acs);
        let symbol = ((r as usize) << 4) + 1;
        let new_nz = u64::from(c[NATURAL_ORDER[k as usize]] >= 0);
        bw.symbol(symbol, ac);
        bw.write(1, new_nz);
        for &b in &rb[..rbc] {
            bw.write(1, u64::from(b));
        }
        rbc = 0;
        r = 0;
    }
    if r > 0 || rbc > 0 {
        let bits = rb[..rbc].to_vec();
        st.buffer_eob(ac_idx, &bits, bw, acs);
        if !eob_run_allowed {
            st.flush(bw, acs);
        }
    }
    true
}

impl JpegData {
    fn mcu_size(&self, s: &ScanInfo) -> (usize, usize) {
        let inter = s.num_components > 1;
        let base = &self.components[s.components[0].comp_idx as usize];
        let hg = if inter { 1 } else { base.h_samp as usize };
        let vg = if inter { 1 } else { base.v_samp as usize };
        let mh = self.components.iter().map(|c| c.h_samp as usize).max().unwrap_or(1);
        let mv = self.components.iter().map(|c| c.v_samp as usize).max().unwrap_or(1);
        ((self.width as usize * hg).div_ceil(8 * mh), (self.height as usize * vg).div_ceil(8 * mv))
    }

    /// Writes the JPEG file.
    pub fn write(&self) -> Result<Vec<u8>> {
        let err = || Error::Invalid("JPEG reconstruction failed");
        let mut out: Vec<u8> = vec![0xFF, 0xD8];
        let mut dc_tables: Vec<HuffTable> = (0..4).map(|_| HuffTable::default()).collect();
        let mut ac_tables: Vec<HuffTable> = (0..4).map(|_| HuffTable::default()).collect();
        let (mut dht_index, mut dqt_index, mut app_index, mut com_index, mut data_index, mut scan_index) = (0, 0, 0, 0, 0, 0);
        let mut progressive = false;
        let mut seen_dri = false;
        let mut pad: Option<(&[u8], usize)> = if self.has_zero_padding_bit { Some((&self.padding_bits, 0)) } else { None };
        for &m in &self.marker_order {
            match m {
                0xC0 | 0xC1 | 0xC2 | 0xC9 | 0xCA => {
                    if m <= 0xC2 {
                        progressive = m == 0xC2;
                    }
                    let n = self.components.len();
                    let len = 8 + 3 * n;
                    out.extend_from_slice(&[0xFF, m, (len >> 8) as u8, len as u8, 8]);
                    out.extend_from_slice(&[(self.height >> 8) as u8, self.height as u8, (self.width >> 8) as u8, self.width as u8, n as u8]);
                    for c in &self.components {
                        let q = self.quant.get(c.quant_idx as usize).ok_or_else(err)?;
                        out.extend_from_slice(&[c.id as u8, ((c.h_samp << 4) | c.v_samp) as u8, q.index as u8]);
                    }
                }
                0xC4 => {
                    let mut len = 2usize;
                    for h in &self.huffman[dht_index.min(self.huffman.len())..] {
                        for &c in &h.counts {
                            len += c as usize;
                        }
                        if len == 2 {
                            break;
                        }
                        len += 16;
                        if h.is_last {
                            break;
                        }
                    }
                    out.extend_from_slice(&[0xFF, 0xC4, (len >> 8) as u8, len as u8]);
                    loop {
                        let h = self.huffman.get(dht_index).ok_or_else(err)?;
                        dht_index += 1;
                        let mut total = 0usize;
                        let mut max_len = 0usize;
                        for (i, &c) in h.counts.iter().enumerate() {
                            if c != 0 {
                                max_len = i;
                            }
                            total += c as usize;
                        }
                        if total == 0 {
                            break;
                        }
                        let idx = (h.slot_id & 0xF) as usize;
                        let t = if h.slot_id & 0x10 != 0 { &mut ac_tables[idx] } else { &mut dc_tables[idx] };
                        t.depth = [127; 256];
                        if !build_huff(h, t) {
                            return Err(err());
                        }
                        t.initialized = true;
                        total -= 1;
                        out.push(h.slot_id as u8);
                        for i in 1..=16 {
                            out.push(if i == max_len { h.counts[i] - 1 } else { h.counts[i] } as u8);
                        }
                        for &v in &h.values[..total] {
                            out.push(v as u8);
                        }
                        if h.is_last {
                            break;
                        }
                    }
                }
                0xD0..=0xD7 => out.extend_from_slice(&[0xFF, m]),
                0xD9 => {
                    out.extend_from_slice(&[0xFF, 0xD9]);
                    out.extend_from_slice(&self.tail_data);
                }
                0xDA => {
                    let s = self.scans.get(scan_index).ok_or_else(err)?;
                    scan_index += 1;
                    self.write_scan(s, progressive, seen_dri, &dc_tables, &ac_tables, &mut pad, &mut out)?;
                }
                0xDB => {
                    let mut len = 2usize;
                    for t in &self.quant[dqt_index.min(self.quant.len())..] {
                        len += 1 + if t.precision != 0 { 2 } else { 1 } * 64;
                        if t.is_last {
                            break;
                        }
                    }
                    out.extend_from_slice(&[0xFF, 0xDB, (len >> 8) as u8, len as u8]);
                    loop {
                        let t = self.quant.get(dqt_index).ok_or_else(err)?;
                        dqt_index += 1;
                        out.push(((t.precision << 4) + t.index) as u8);
                        for &nat in NATURAL_ORDER.iter().take(64) {
                            let v = t.values[nat];
                            if t.precision != 0 {
                                out.push((v >> 8) as u8);
                            }
                            out.push(v as u8);
                        }
                        if t.is_last {
                            break;
                        }
                    }
                }
                0xDD => {
                    seen_dri = true;
                    out.extend_from_slice(&[0xFF, 0xDD, 0, 4, (self.restart_interval >> 8) as u8, self.restart_interval as u8]);
                }
                0xE0..=0xEF => {
                    let a = self.app_data.get(app_index).ok_or_else(err)?;
                    app_index += 1;
                    out.push(0xFF);
                    out.extend_from_slice(a);
                }
                0xFE => {
                    let c = self.com_data.get(com_index).ok_or_else(err)?;
                    com_index += 1;
                    out.push(0xFF);
                    out.extend_from_slice(c);
                }
                0xFF => {
                    let d = self.inter_marker_data.get(data_index).ok_or_else(err)?;
                    data_index += 1;
                    out.extend_from_slice(d);
                }
                _ => return Err(err()),
            }
        }
        if let Some((bits, pos)) = pad {
            if pos != bits.len() {
                return invalid("JPEG padding bits left over");
            }
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    fn write_scan(
        &self,
        s: &ScanInfo,
        progressive: bool,
        seen_dri: bool,
        dc_tables: &[HuffTable],
        ac_tables: &[HuffTable],
        pad: &mut Option<(&[u8], usize)>,
        out: &mut Vec<u8>,
    ) -> Result<()> {
        let err = || Error::Invalid("JPEG reconstruction failed");
        let n = s.num_components as usize;
        let len = 6 + 2 * n;
        out.extend_from_slice(&[0xFF, 0xDA, (len >> 8) as u8, len as u8, n as u8]);
        for c in &s.components[..n] {
            let comp = self.components.get(c.comp_idx as usize).ok_or_else(err)?;
            out.push(comp.id as u8);
            out.push(((c.dc_tbl_idx << 4) + c.ac_tbl_idx) as u8);
        }
        out.extend_from_slice(&[s.ss as u8, s.se as u8, ((s.ah << 4) | s.al) as u8]);
        let restart_interval = if seen_dri { self.restart_interval } else { 0 };
        let al = if progressive { s.al } else { 0 };
        let ah = if progressive { s.ah } else { 0 };
        let ss = if progressive { s.ss as i32 } else { 0 };
        let se = if progressive { s.se as i32 } else { 63 };
        let mode = if !progressive || (ah == 0 && al == 0 && ss == 0 && se == 63) {
            0
        } else if ah == 0 {
            1
        } else {
            2
        };
        let want_ac = ss != 0 || se != 0;
        let want_dc = ss == 0;
        let mut bw = BitWriter::new();
        let mut st = CodingState { eob_run: 0, cur_ac: 0, refinement_bits: Vec::new(), refinement_bits_count: 0 };
        let mut restarts_to_go = restart_interval;
        let mut next_restart = 0u8;
        let mut block_scan_index = 0u32;
        let mut ezr_pos = 0usize;
        let next_ezr = |pos: usize| s.extra_zero_runs.get(pos).map(|e| i64::from(e.0)).unwrap_or(-1);
        let mut next_ezr_index = next_ezr(0);
        let mut reset_pos = 0usize;
        let mut next_reset = s.reset_points.first().map(|&v| i64::from(v)).unwrap_or(-1);
        if next_reset >= 0 {
            reset_pos = 1;
        }
        let mut last_dc = [0i16; 4];
        let inter = n > 1;
        let (mcus_per_row, mcu_rows) = self.mcu_size(s);
        for mcu_y in 0..mcu_rows {
            for mcu_x in 0..mcus_per_row {
                if restart_interval > 0 && restarts_to_go == 0 {
                    st.flush(&mut bw, ac_tables);
                    if !bw.jump_to_byte_boundary(pad) {
                        return Err(err());
                    }
                    bw.marker(0xD0 + next_restart);
                    next_restart = (next_restart + 1) & 7;
                    restarts_to_go = restart_interval;
                    last_dc = [0; 4];
                }
                for sc in &s.components[..n] {
                    let c = &self.components[sc.comp_idx as usize];
                    let dc = &dc_tables[sc.dc_tbl_idx as usize];
                    let aci = sc.ac_tbl_idx as usize;
                    if want_dc && !dc.initialized {
                        return Err(err());
                    }
                    if want_ac && !ac_tables[aci].initialized {
                        return Err(err());
                    }
                    let nby = if inter { c.v_samp as usize } else { 1 };
                    let nbx = if inter { c.h_samp as usize } else { 1 };
                    for iy in 0..nby {
                        for ix in 0..nbx {
                            let by = mcu_y * nby + iy;
                            let bx = mcu_x * nbx + ix;
                            let bidx = by * c.width_in_blocks + bx;
                            if i64::from(block_scan_index) == next_reset {
                                st.flush(&mut bw, ac_tables);
                                next_reset = s.reset_points.get(reset_pos).map(|&v| i64::from(v)).unwrap_or(-1);
                                reset_pos += 1;
                            }
                            let mut zero_runs = 0;
                            if i64::from(block_scan_index) == next_ezr_index {
                                zero_runs = s.extra_zero_runs[ezr_pos].1;
                                ezr_pos += 1;
                                next_ezr_index = next_ezr(ezr_pos);
                            }
                            let coeffs = c.coeffs.get(bidx * 64..bidx * 64 + 64).ok_or_else(err)?;
                            let ok = match mode {
                                0 => encode_block_sequential(coeffs, dc, &ac_tables[aci], zero_runs, &mut last_dc[sc.comp_idx as usize], &mut bw),
                                1 => encode_block_progressive(coeffs, dc, aci, ac_tables, ss, se, al, zero_runs, &mut st, &mut last_dc[sc.comp_idx as usize], &mut bw),
                                _ => encode_refinement(coeffs, aci, ac_tables, ss, se, al, &mut st, &mut bw),
                            };
                            if !ok {
                                return Err(err());
                            }
                            block_scan_index += 1;
                        }
                    }
                }
                restarts_to_go = restarts_to_go.wrapping_sub(1);
            }
        }
        st.flush(&mut bw, ac_tables);
        if !bw.jump_to_byte_boundary(pad) || !bw.healthy {
            return Err(err());
        }
        out.extend_from_slice(&bw.out);
        Ok(())
    }
}
