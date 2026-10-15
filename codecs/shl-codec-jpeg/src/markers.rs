//! Marker segment parsing (T.81 Annex B) and the top-level decode loop.

use crate::huffman::{std_table, HuffTable};
use crate::{dct, invalid, lossless, unsupported, Image};
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
    /// Successive approximation low bit (DCT) or point transform (lossless).
    pub(crate) al: u8,
}

#[derive(Default)]
pub(crate) struct Tables {
    pub(crate) dc: [Option<HuffTable>; 4],
    pub(crate) ac: [Option<HuffTable>; 4],
    /// Quantisation tables in natural order.
    pub(crate) quant: [Option<[u16; 64]>; 4],
    pub(crate) restart_interval: usize,
    pub(crate) jfif: bool,
    pub(crate) adobe_transform: Option<u8>,
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

fn parse_sof(s: &[u8], process: Process, info: &FrameInfo) -> Result<Frame> {
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
    match process {
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
    // Check geometry against the dataset before any allocation sized from the codestream.
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
        comps.push(Component { id, h, v, tq });
    }
    let hmax = comps.iter().map(|c| c.h).max().unwrap_or(1);
    let vmax = comps.iter().map(|c| c.v).max().unwrap_or(1);
    Ok(Frame { process, precision, width, height, comps, hmax, vmax })
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
    // Se and Ah are ignored: sequential DCT decodes all 64 coefficients whatever they say (as
    // libjpeg does), and lossless scans do not use them.
    Ok(Scan { comps, ss: s[b], al: s[b + 2] & 15 })
}

/// `cornell`: lossless only, decode with the Cornell 16-bit encoder workaround.
/// `scale_log2`: DCT only, decode at 1/2^scale_log2 size (0 to 3); lossless refuses any
/// reduced scale as Unsupported.
pub(crate) fn decode(d: &[u8], info: &FrameInfo, cornell: bool, scale_log2: u8) -> Result<Image> {
    if d.len() < 2 || d[0] != 0xFF || d[1] != 0xD8 {
        return Err(invalid("codestream does not start with SOI"));
    }
    let mut r = Reader { d, pos: 2 };
    let mut tables = Tables::default();
    let mut frame: Option<Frame> = None;
    let mut state: Option<State> = None;
    let mut scans = 0usize;
    // A missing EOI ends the loop at end of data: libjpeg warns and keeps what it decoded.
    while let Some(m) = r.next_marker() {
        match m {
            0xD9 => break,
            0xD8 => return Err(invalid("second SOI")),
            0xD0..=0xD7 | 0x01 => {} // stray RSTn or TEM: no payload
            0xC0 | 0xC1 | 0xC3 => {
                let s = r.segment()?;
                if frame.is_some() {
                    return Err(invalid("more than one SOF"));
                }
                let f = parse_sof(s, if m == 0xC3 { Process::Lossless } else { Process::Dct }, info)?;
                if scale_log2 > 0 && f.process == Process::Lossless {
                    return Err(unsupported("lossless JPEG has no reduced-resolution decode"));
                }
                // Every DCT block costs at least 2 bits (DC code and EOB) and every lossless sample
                // at least 1, so a frame larger than that bound cannot be in this codestream.
                // Checked before allocating, so a short stream cannot claim a huge image.
                let min_bits: usize = (0..f.comps.len())
                    .map(|c| {
                        let (cw, ch) = f.comp_size(c);
                        match f.process {
                            Process::Dct => cw.div_ceil(8) * ch.div_ceil(8) * 2,
                            Process::Lossless => cw * ch,
                        }
                    })
                    .sum();
                if min_bits > d.len().saturating_mul(8) {
                    return Err(invalid("codestream too short for the frame size"));
                }
                state = Some(match f.process {
                    Process::Dct if f.precision == 8 => State::Dct8(dct::DctDecoder::new(&f, scale_log2)?),
                    Process::Dct => State::Dct12(dct::DctDecoder::new(&f, scale_log2)?),
                    Process::Lossless => State::Lossless(lossless::LosslessDecoder::new(&f, cornell)?),
                });
                frame = Some(f);
            }
            0xC2 => return Err(unsupported("progressive JPEG (process 10/12)")),
            0xC5..=0xC7 => return Err(unsupported("hierarchical JPEG")),
            0xC9..=0xCB | 0xCD..=0xCF => return Err(unsupported("arithmetic-coded JPEG")),
            0xC4 => parse_dht(r.segment()?, &mut tables)?,
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
                let (Some(f), Some(st)) = (frame.as_ref(), state.as_mut()) else {
                    return Err(invalid("SOS before SOF"));
                };
                let scan = parse_sos(s, f)?;
                // Motion-JPEG style frames may omit DHT; libjpeg-turbo then uses the K.3 tables.
                if f.process == Process::Dct && f.precision == 8 {
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
            0xDC => {
                r.segment()?;
            }
            _ => {
                // APPn, COM, DHP, EXP, JPGn and reserved markers: skip the segment.
                r.segment()?;
            }
        }
    }
    let (Some(f), Some(st)) = (frame, state) else {
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
