//! Marker segment parsing (T.81 Annex B) and the top-level decode loop.

use crate::huffman::{std_table, HuffTable};
use crate::{dct, hier, invalid, lossless, unsupported, Image};
use shl_codec_common::{FrameInfo, Result};

/// Natural (row-major) index of each zig-zag position, with 16 extra entries so a corrupt run
/// length past 63 lands on 63, as in libjpeg's `jpeg_natural_order`.
pub(crate) const ZIGZAG: [usize; 80] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
    45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
    63, 63, 63, 63, 63,
];

#[derive(Clone, Copy, Debug)]
pub(crate) struct Component {
    pub(crate) id: u8,
    pub(crate) h: usize,
    pub(crate) v: usize,
    pub(crate) tq: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Process {
    Dct,
    Lossless,
}

#[derive(Clone, Debug)]
pub(crate) struct Frame {
    pub(crate) process: Process,
    /// Arithmetic coding (SOF9–11, SOF13–15) instead of Huffman.
    pub(crate) arithmetic: bool,
    /// Progressive DCT (SOF2, 6, 10, 14).
    pub(crate) progressive: bool,
    /// A differential frame of a hierarchical image (SOF5–7, SOF13–15).
    pub(crate) differential: bool,
    pub(crate) precision: u8,
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) comps: Vec<Component>,
    pub(crate) hmax: usize,
    pub(crate) vmax: usize,
}

impl Frame {
    /// MCUs per row and column for an interleaved scan, in units of `unit` samples per block side
    /// (8 for DCT, 1 for lossless).
    pub(crate) fn mcus(&self, unit: usize) -> (usize, usize) {
        (self.width.div_ceil(unit * self.hmax), self.height.div_ceil(unit * self.vmax))
    }
    /// Size of component `c` in samples, before upsampling (ceil(X·H/Hmax), ceil(Y·V/Vmax)).
    pub(crate) fn comp_size(&self, c: usize) -> (usize, usize) {
        let k = &self.comps[c];
        ((self.width * k.h).div_ceil(self.hmax), (self.height * k.v).div_ceil(self.vmax))
    }
}

pub(crate) struct ScanComp {
    pub(crate) index: usize,
    pub(crate) td: usize,
    pub(crate) ta: usize,
}

pub(crate) struct Scan {
    pub(crate) comps: Vec<ScanComp>,
    /// Spectral start (DCT) or predictor selection value (lossless).
    pub(crate) ss: u8,
    /// Spectral end (progressive DCT).
    pub(crate) se: u8,
    /// Successive approximation high bit (progressive DCT).
    pub(crate) ah: u8,
    /// Successive approximation low bit (DCT) or point transform (lossless).
    pub(crate) al: u8,
}

pub(crate) struct Tables {
    pub(crate) dc: [Option<HuffTable>; 4],
    pub(crate) ac: [Option<HuffTable>; 4],
    /// Quantisation tables in natural order.
    pub(crate) quant: [Option<[u16; 64]>; 4],
    pub(crate) restart_interval: usize,
    pub(crate) jfif: bool,
    pub(crate) adobe_transform: Option<u8>,
    /// Arithmetic conditioning (DAC, T.81 B.2.4.3): DC and lossless L and U, AC Kx.
    pub(crate) arith_dc_l: [u8; 4],
    pub(crate) arith_dc_u: [u8; 4],
    pub(crate) arith_ac_k: [u8; 4],
}

impl Default for Tables {
    fn default() -> Self {
        Self {
            dc: Default::default(),
            ac: Default::default(),
            quant: [None; 4],
            restart_interval: 0,
            jfif: false,
            adobe_transform: None,
            arith_dc_l: [0; 4],
            arith_dc_u: [1; 4],
            arith_ac_k: [5; 4],
        }
    }
}

impl Tables {
    pub(crate) fn dc_table(&self, id: usize) -> Result<&HuffTable> {
        self.dc.get(id).and_then(|t| t.as_ref()).ok_or_else(|| invalid("scan uses an undefined DC Huffman table"))
    }
    pub(crate) fn ac_table(&self, id: usize) -> Result<&HuffTable> {
        self.ac.get(id).and_then(|t| t.as_ref()).ok_or_else(|| invalid("scan uses an undefined AC Huffman table"))
    }
}

enum State {
    /// 8-bit precision stores samples as u8, 12-bit as u16.
    Dct8(dct::DctDecoder<u8>),
    Dct12(dct::DctDecoder<u16>),
    Lossless(lossless::LosslessDecoder),
}

struct Reader<'a> {
    d: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    /// Next marker code, skipping any garbage and fill bytes before it. None at end of data.
    fn next_marker(&mut self) -> Option<u8> {
        loop {
            while *self.d.get(self.pos)? != 0xFF {
                self.pos += 1;
            }
            while *self.d.get(self.pos)? == 0xFF {
                self.pos += 1;
            }
            let m = *self.d.get(self.pos)?;
            self.pos += 1;
            if m != 0 {
                return Some(m);
            }
        }
    }

    /// The payload of a length-prefixed segment.
    fn segment(&mut self) -> Result<&'a [u8]> {
        let hi = *self.d.get(self.pos).ok_or_else(|| invalid("truncated marker segment"))?;
        let lo = *self.d.get(self.pos + 1).ok_or_else(|| invalid("truncated marker segment"))?;
        let len = usize::from(u16::from_be_bytes([hi, lo]));
        if len < 2 {
            return Err(invalid("marker segment length < 2"));
        }
        let end = self.pos + len;
        let s = self.d.get(self.pos + 2..end).ok_or_else(|| invalid("truncated marker segment"))?;
        self.pos = end;
        Ok(s)
    }
}

/// Index just past the entropy-coded data starting at `start`: the first marker that is not
/// RSTn (stuffed `FF 00` and fill bytes are skipped).
fn scan_end(d: &[u8], start: usize) -> usize {
    let mut p = start;
    while p < d.len() {
        // Skip eight bytes at a time while none is 0xFF (a zero byte in the complement).
        while let Some(c) = d.get(p..p + 8) {
            let nw = !u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
            if nw.wrapping_sub(0x0101_0101_0101_0101) & !nw & 0x8080_8080_8080_8080 != 0 {
                break;
            }
            p += 8;
        }
        if p >= d.len() {
            break;
        }
        if d[p] != 0xFF {
            p += 1;
            continue;
        }
        let mut q = p + 1;
        while q < d.len() && d[q] == 0xFF {
            q += 1;
        }
        match d.get(q) {
            None => return d.len(),
            Some(&b) if b == 0 || (0xD0..=0xD7).contains(&b) => p = q + 1,
            Some(_) => return q - 1,
        }
    }
    d.len()
}

/// What a SOFn marker says about the frame's coding process.
#[derive(Clone, Copy)]
pub(crate) struct SofKind {
    pub(crate) process: Process,
    pub(crate) arithmetic: bool,
    pub(crate) progressive: bool,
    pub(crate) differential: bool,
}

/// SOFn markers (T.81 Table B.1). SOF4/C8/CC are not frames.
pub(crate) fn sof_kind(m: u8) -> Option<SofKind> {
    let (process, progressive) = match m & 3 {
        0 | 1 => (Process::Dct, false),
        2 => (Process::Dct, true),
        _ => (Process::Lossless, false),
    };
    let differential = matches!(m, 0xC5..=0xC7 | 0xCD..=0xCF);
    let arithmetic = m >= 0xC9;
    match m {
        0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
            Some(SofKind { process, arithmetic, progressive, differential })
        }
        _ => None,
    }
}

/// Parse a SOFn (or, with `kind` None, a DHP) segment. Outside a hierarchical image (`dhp`
/// None) the frame must match the dataset's size and Samples per Pixel; inside one, it must fit
/// the DHP and name only its components.
fn parse_sof(s: &[u8], kind: Option<SofKind>, info: &FrameInfo, dhp: Option<&Frame>) -> Result<Frame> {
    if s.len() < 6 {
        return Err(invalid("short SOF"));
    }
    let precision = s[0];
    let height = usize::from(u16::from_be_bytes([s[1], s[2]]));
    let width = usize::from(u16::from_be_bytes([s[3], s[4]]));
    let nf = usize::from(s[5]);
    if s.len() < 6 + 3 * nf {
        return Err(invalid("short SOF"));
    }
    let k = kind.unwrap_or(SofKind { process: Process::Lossless, arithmetic: false, progressive: false, differential: false });
    match k.process {
        Process::Dct if precision != 8 && precision != 12 => {
            return Err(invalid(&format!("DCT precision {precision} (must be 8 or 12)")))
        }
        Process::Lossless if !(2..=16).contains(&precision) => {
            return Err(invalid(&format!("lossless precision {precision} (must be 2-16)")))
        }
        _ => {}
    }
    if height == 0 {
        return Err(unsupported("frame height defined by DNL marker"));
    }
    if width == 0 {
        return Err(invalid("frame width 0"));
    }
    match dhp {
        // Check geometry against the dataset before any allocation sized from the codestream.
        None => {
            if width != info.columns as usize || height != info.rows as usize {
                return Err(invalid(&format!(
                    "JPEG is {width}x{height} but the dataset says {}x{}",
                    info.columns, info.rows
                )));
            }
            if nf == 0 || nf != usize::from(info.samples_per_pixel) {
                return Err(invalid(&format!(
                    "JPEG has {nf} components but Samples per Pixel is {}",
                    info.samples_per_pixel
                )));
            }
        }
        Some(d) => {
            if width > d.width || height > d.height || nf == 0 || nf > d.comps.len() {
                return Err(invalid("hierarchical frame larger than the DHP image"));
            }
        }
    }
    let mut comps = Vec::with_capacity(nf);
    for k in 0..nf {
        let id = s[6 + 3 * k];
        let h = usize::from(s[7 + 3 * k] >> 4);
        let v = usize::from(s[7 + 3 * k] & 15);
        let tq = usize::from(s[8 + 3 * k]);
        if !(1..=4).contains(&h) || !(1..=4).contains(&v) {
            return Err(invalid("sampling factor outside 1-4"));
        }
        if tq > 3 {
            return Err(invalid("quantisation table selector > 3"));
        }
        if comps.iter().any(|c: &Component| c.id == id) {
            return Err(invalid("duplicate component identifier"));
        }
        if let Some(d) = dhp {
            if !d.comps.iter().any(|c| c.id == id) {
                return Err(invalid("hierarchical frame names a component not in the DHP"));
            }
        }
        comps.push(Component { id, h, v, tq });
    }
    let hmax = comps.iter().map(|c| c.h).max().unwrap_or(1);
    let vmax = comps.iter().map(|c| c.v).max().unwrap_or(1);
    Ok(Frame {
        process: k.process,
        arithmetic: k.arithmetic,
        progressive: k.progressive,
        differential: k.differential,
        precision,
        width,
        height,
        comps,
        hmax,
        vmax,
    })
}

/// DAC (T.81 B.2.4.3): Tc/Tb then the conditioning value.
fn parse_dac(s: &[u8], t: &mut Tables) -> Result<()> {
    if !s.len().is_multiple_of(2) {
        return Err(invalid("bad DAC length"));
    }
    for p in s.chunks_exact(2) {
        let (class, id, v) = (p[0] >> 4, usize::from(p[0] & 15), p[1]);
        if class > 1 {
            return Err(invalid("bad DAC table class"));
        }
        if id > 3 {
            continue; // scans can only select tables 0-3
        }
        if class == 0 {
            let (l, u) = (v & 15, v >> 4);
            if l > u {
                return Err(invalid("DAC lower bound above upper bound"));
            }
            t.arith_dc_l[id] = l;
            t.arith_dc_u[id] = u;
        } else {
            if !(1..=63).contains(&v) {
                return Err(invalid("DAC Kx outside 1-63"));
            }
            t.arith_ac_k[id] = v;
        }
    }
    Ok(())
}

fn parse_dht(mut s: &[u8], t: &mut Tables) -> Result<()> {
    while !s.is_empty() {
        if s.len() < 17 {
            return Err(invalid("short DHT"));
        }
        let class = s[0] >> 4;
        let id = usize::from(s[0] & 15);
        if class > 1 || id > 3 {
            return Err(invalid("bad DHT class or identifier"));
        }
        let mut counts = [0u8; 16];
        counts.copy_from_slice(&s[1..17]);
        let n: usize = counts.iter().map(|&c| usize::from(c)).sum();
        let vals = s.get(17..17 + n).ok_or_else(|| invalid("short DHT"))?;
        let table = HuffTable::new(&counts, vals, class)?;
        if class == 0 {
            t.dc[id] = Some(table);
        } else {
            t.ac[id] = Some(table);
        }
        s = &s[17 + n..];
    }
    Ok(())
}

fn parse_dqt(mut s: &[u8], t: &mut Tables) -> Result<()> {
    while !s.is_empty() {
        let pq = s[0] >> 4;
        let id = usize::from(s[0] & 15);
        if pq > 1 || id > 3 {
            return Err(invalid("bad DQT precision or identifier"));
        }
        let size = if pq == 0 { 64 } else { 128 };
        let body = s.get(1..1 + size).ok_or_else(|| invalid("short DQT"))?;
        let mut q = [0u16; 64];
        for k in 0..64 {
            q[ZIGZAG[k]] = if pq == 0 { u16::from(body[k]) } else { u16::from_be_bytes([body[2 * k], body[2 * k + 1]]) };
        }
        t.quant[id] = Some(q);
        s = &s[1 + size..];
    }
    Ok(())
}

fn parse_sos(s: &[u8], frame: &Frame) -> Result<Scan> {
    let ns = usize::from(*s.first().ok_or_else(|| invalid("short SOS"))?);
    if !(1..=4).contains(&ns) || s.len() < 1 + 2 * ns + 3 {
        return Err(invalid("bad SOS"));
    }
    let mut comps = Vec::with_capacity(ns);
    for k in 0..ns {
        let id = s[1 + 2 * k];
        let index = frame
            .comps
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| invalid("scan names a component not in the frame"))?;
        if comps.iter().any(|c: &ScanComp| c.index == index) {
            return Err(invalid("component repeated in scan"));
        }
        let td = usize::from(s[2 + 2 * k] >> 4);
        let ta = usize::from(s[2 + 2 * k] & 15);
        if td > 3 || ta > 3 {
            return Err(invalid("Huffman table selector > 3"));
        }
        comps.push(ScanComp { index, td, ta });
    }
    if ns > 1 {
        let blocks: usize = comps.iter().map(|c| frame.comps[c.index].h * frame.comps[c.index].v).sum();
        if blocks > 10 {
            return Err(invalid("more than 10 blocks per MCU"));
        }
    }
    let b = 1 + 2 * ns;
    // Sequential DCT ignores Se and Ah: it decodes all 64 coefficients whatever they say (as
    // libjpeg does), and lossless scans do not use them.
    Ok(Scan { comps, ss: s[b], se: s[b + 1], ah: s[b + 2] >> 4, al: s[b + 2] & 15 })
}

impl State {
    fn new(f: &Frame, scale_log2: u8, cornell: bool, hierarchical: bool, kernels: crate::simd::Kernels) -> Result<Self> {
        // Every DCT process but sequential Huffman keeps coefficients until the end.
        let buffered = hierarchical || f.progressive || f.arithmetic;
        Ok(match f.process {
            Process::Dct if f.precision == 8 => State::Dct8(dct::DctDecoder::new(f, scale_log2, buffered, !hierarchical, kernels)?),
            Process::Dct => State::Dct12(dct::DctDecoder::new(f, scale_log2, buffered, !hierarchical, kernels)?),
            Process::Lossless => State::Lossless(lossless::LosslessDecoder::new(f, cornell)?),
        })
    }

    fn out(&self) -> hier::FrameOut<'_> {
        match self {
            State::Dct8(d) => hier::FrameOut::Dct8(d),
            State::Dct12(d) => hier::FrameOut::Dct12(d),
            State::Lossless(d) => hier::FrameOut::Lossless(d),
        }
    }
}

/// Smallest number of bits a frame's scans can take, used to refuse a short codestream that
/// claims a huge image before allocating for it. Sequential Huffman DCT needs at least 2 bits per
/// block (DC code and EOB), progressive 1 (the DC code of the first scan), lossless Huffman 1
/// per sample. Arithmetic coding can code a flat image in a few bytes, so it has no bound.
fn min_bits(f: &Frame) -> usize {
    if f.arithmetic {
        return 0;
    }
    (0..f.comps.len())
        .map(|c| {
            let (cw, ch) = f.comp_size(c);
            match f.process {
                Process::Dct if f.progressive => cw.div_ceil(8) * ch.div_ceil(8),
                Process::Dct => cw.div_ceil(8) * ch.div_ceil(8) * 2,
                Process::Lossless => cw * ch,
            }
        })
        .sum()
}

/// `cornell`: lossless only, decode with the Cornell 16-bit encoder workaround.
/// `scale_log2`: DCT only, decode at 1/2^scale_log2 size (0 to 3); lossless and hierarchical
/// images refuse any reduced scale as Unsupported.
pub(crate) fn decode(d: &[u8], info: &FrameInfo, cornell: bool, scale_log2: u8) -> Result<Image> {
    crate::simd::with_kernels(|k| decode_with(d, info, cornell, scale_log2, k))
}

/// [`decode`] with the kernel set chosen.
fn decode_with(d: &[u8], info: &FrameInfo, cornell: bool, scale_log2: u8, kernels: crate::simd::Kernels) -> Result<Image> {
    if d.len() < 2 || d[0] != 0xFF || d[1] != 0xD8 {
        return Err(invalid("codestream does not start with SOI"));
    }
    let mut r = Reader { d, pos: 2 };
    let mut tables = Tables::default();
    // The current frame and its decoder; with `hier`, every frame of a hierarchical image.
    let mut cur: Option<(Frame, State, (bool, bool))> = None;
    let mut hier: Option<hier::Hier> = None;
    let mut exp = (false, false);
    let mut scans = 0usize;
    // A missing EOI ends the loop at end of data: libjpeg warns and keeps what it decoded.
    while let Some(m) = r.next_marker() {
        match m {
            0xD9 => break,
            0xD8 => return Err(invalid("second SOI")),
            0xD0..=0xD7 | 0x01 => {} // stray RSTn or TEM: no payload
            0xDE => {
                let s = r.segment()?;
                if cur.is_some() || hier.is_some() {
                    return Err(invalid("DHP after a frame"));
                }
                if scale_log2 > 0 {
                    return Err(unsupported("hierarchical JPEG has no reduced-resolution decode"));
                }
                let f = parse_sof(s, None, info, None)?;
                if min_bits(&f) > 0 && f.width.saturating_mul(f.height) / 64 > d.len().saturating_mul(8) {
                    return Err(invalid("codestream too short for the frame size"));
                }
                hier = Some(hier::Hier::new(f));
            }
            0xDF => {
                let s = r.segment()?;
                let (Some(&e), true) = (s.first(), hier.is_some()) else {
                    return Err(invalid("EXP outside a hierarchical image"));
                };
                if (e >> 4) > 1 || (e & 15) > 1 {
                    return Err(invalid("EXP expansion other than 0 or 1"));
                }
                exp = (e >> 4 == 1, e & 15 == 1);
            }
            _ if sof_kind(m).is_some() => {
                let Some(kind) = sof_kind(m) else { continue };
                let s = r.segment()?;
                if let Some(h) = hier.as_mut() {
                    if let Some((f, st, e)) = cur.take() {
                        if scans == 0 {
                            return Err(invalid("hierarchical frame with no scan"));
                        }
                        h.add(&f, st.out(), &tables, e)?;
                    }
                    let f = parse_sof(s, Some(kind), info, Some(&h.dhp))?;
                    let st = State::new(&f, 0, false, true, kernels)?;
                    cur = Some((f, st, exp));
                    exp = (false, false);
                    scans = 0;
                    continue;
                }
                if kind.differential {
                    return Err(invalid("differential frame outside a hierarchical image"));
                }
                if cur.is_some() {
                    return Err(invalid("more than one SOF"));
                }
                let f = parse_sof(s, Some(kind), info, None)?;
                if scale_log2 > 0 && f.process == Process::Lossless {
                    return Err(unsupported("lossless JPEG has no reduced-resolution decode"));
                }
                // Checked before allocating, so a short stream cannot claim a huge image.
                if min_bits(&f) > d.len().saturating_mul(8) {
                    return Err(invalid("codestream too short for the frame size"));
                }
                let st = State::new(&f, scale_log2, cornell, false, kernels)?;
                cur = Some((f, st, (false, false)));
            }
            0xC4 => parse_dht(r.segment()?, &mut tables)?,
            0xCC => parse_dac(r.segment()?, &mut tables)?,
            0xDB => parse_dqt(r.segment()?, &mut tables)?,
            0xDD => {
                let s = r.segment()?;
                if s.len() < 2 {
                    return Err(invalid("short DRI"));
                }
                tables.restart_interval = usize::from(u16::from_be_bytes([s[0], s[1]]));
            }
            0xE0 => {
                let s = r.segment()?;
                if s.len() >= 14 && s.starts_with(b"JFIF\0") {
                    tables.jfif = true;
                }
            }
            0xEE => {
                let s = r.segment()?;
                if s.len() >= 12 && s.starts_with(b"Adobe") {
                    tables.adobe_transform = Some(s[11]);
                }
            }
            0xDA => {
                let s = r.segment()?;
                let Some((f, st, _)) = cur.as_mut() else {
                    return Err(invalid("SOS before SOF"));
                };
                let f = &*f;
                let scan = parse_sos(s, f)?;
                // Motion-JPEG style frames may omit DHT; libjpeg-turbo then uses the K.3 tables.
                if f.process == Process::Dct && f.precision == 8 && !f.arithmetic {
                    for c in &scan.comps {
                        if tables.dc[c.td].is_none() {
                            tables.dc[c.td] = std_table(0, c.td as u8);
                        }
                        if tables.ac[c.ta].is_none() {
                            tables.ac[c.ta] = std_table(1, c.ta as u8);
                        }
                    }
                }
                let start = r.pos;
                let end = scan_end(d, start);
                let data = &d[start..end];
                match st {
                    State::Dct8(dec) => dec.decode_scan(data, &scan, &tables, f)?,
                    State::Dct12(dec) => dec.decode_scan(data, &scan, &tables, f)?,
                    State::Lossless(dec) => dec.decode_scan(data, &scan, &tables, f)?,
                }
                scans += 1;
                r.pos = end;
            }
            _ => {
                // APPn, COM, DNL, JPGn and reserved markers: skip the segment.
                r.segment()?;
            }
        }
    }
    if let Some(mut h) = hier {
        let Some((f, st, e)) = cur.take() else {
            return Err(invalid("hierarchical image with no frame"));
        };
        if scans == 0 {
            return Err(invalid("no scan before end of codestream"));
        }
        h.add(&f, st.out(), &tables, e)?;
        return h.finish(&tables, info.photometric, info.bytes_per_sample(), kernels);
    }
    let Some((f, st, _)) = cur else {
        return Err(invalid("no SOF before end of codestream"));
    };
    if scans == 0 {
        return Err(invalid("no scan before end of codestream"));
    }
    match st {
        State::Dct8(dec) => dec.finish(&f, &tables, info.photometric, info.bytes_per_sample()),
        State::Dct12(dec) => dec.finish(&f, &tables, info.photometric, info.bytes_per_sample()),
        State::Lossless(dec) => dec.finish(&f, info.bytes_per_sample(), info.photometric),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_end_skips_stuffing_and_restarts() {
        let d = [1, 0xFF, 0x00, 2, 0xFF, 0xD3, 3, 0xFF, 0xFF, 0xD9];
        assert_eq!(scan_end(&d, 0), 8);
        assert_eq!(scan_end(&[1, 2, 3], 0), 3);
        assert_eq!(scan_end(&[1, 0xFF], 0), 2);
    }
}
