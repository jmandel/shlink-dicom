//! Lossless JPEG (T.81 Annex H, process 14): predictors 1–7, point transform, 2–16 bits.

use crate::bits::{extend, BitReader, Bits};
use crate::huffman::HuffTable;
use crate::markers::{Frame, Scan, Tables};
use crate::out::{interleave_row, put_row, Sink};
use crate::{invalid, Image};
use shl_codec_common::{Photometric, Result};

struct Plane {
    data: Vec<u16>,
    stride: usize,
    pt: u8,
}

pub(crate) struct LosslessDecoder {
    planes: Vec<Plane>,
    /// Read 16 extra bits after SSSS = 16, as the buggy Cornell 16-bit encoder wrote them
    /// (dcmtk's `--workaround-cornell`).
    cornell: bool,
    /// Undecodable codes met so far (decoded as difference 0, as libjpeg does).
    pub(crate) bad_codes: u32,
    /// Whether any SSSS = 16 difference was decoded.
    pub(crate) saw_ssss16: bool,
}

/// Where the current restart interval began in one component: samples on that line from that
/// column on are "first line" samples (H.1.2.1), and the very first takes the default prediction.
#[derive(Clone, Copy)]
struct LineStart {
    row: usize,
    col: usize,
}

impl LosslessDecoder {
    pub(crate) fn new(f: &Frame, cornell: bool) -> Result<Self> {
        let (mx, my) = f.mcus(1);
        let mut planes = Vec::with_capacity(f.comps.len());
        for c in &f.comps {
            let stride = mx * c.h;
            let n = stride.checked_mul(my * c.v).ok_or_else(|| invalid("image too large"))?;
            planes.push(Plane { data: vec![0; n], stride, pt: 0 });
        }
        Ok(Self { planes, cornell, bad_codes: 0, saw_ssss16: false })
    }

    pub(crate) fn decode_scan(&mut self, data: &[u8], scan: &Scan, t: &Tables, f: &Frame) -> Result<()> {
        let psv = scan.ss;
        if !(1..=7).contains(&psv) {
            return Err(invalid(&format!("lossless predictor selection value {psv} (must be 1-7)")));
        }
        let pt = scan.al;
        if pt >= f.precision {
            return Err(invalid("point transform >= precision"));
        }
        let initial = 1i32 << (f.precision - pt - 1);
        let mut tabs: Vec<&HuffTable> = Vec::with_capacity(scan.comps.len());
        for sc in &scan.comps {
            tabs.push(t.dc_table(sc.td)?);
            self.planes[sc.index].pt = pt;
        }
        let mut r = BitReader::new(data);
        r.cornell = self.cornell;
        let ri = t.restart_interval;
        let result = self.decode_scan_with(&mut r, scan, f, &tabs, ri, psv, initial);
        self.bad_codes += r.bad_codes;
        self.saw_ssss16 |= r.ssss16;
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn decode_scan_with(
        &mut self,
        r: &mut BitReader,
        scan: &Scan,
        f: &Frame,
        tabs: &[&HuffTable],
        ri: usize,
        psv: u8,
        initial: i32,
    ) -> Result<()> {
        // Row-wise decoding covers a single-component scan and interleaved scans whose components
        // are all full size (one sample per component per MCU, the usual colour case).
        let full = scan.comps.iter().all(|sc| f.comps[sc.index].h == 1 && f.comps[sc.index].v == 1);
        if scan.comps.len() == 1 || full {
            let (cw, ch) = f.comp_size(scan.comps[0].index);
            let idx: Vec<usize> = scan.comps.iter().map(|sc| sc.index).collect();
            let mut by_index: Vec<Option<&mut Plane>> = self.planes.iter_mut().map(Some).collect();
            let mut planes: Vec<&mut Plane> = Vec::with_capacity(idx.len());
            for &i in &idx {
                planes.push(by_index[i].take().ok_or_else(|| invalid("component repeated in scan"))?);
            }
            return decode_rows(r, tabs, &mut planes, cw, ch, ri, psv, initial);
        }

        // Interleaved scans with subsampled components: one sample at a time.
        let mut ctx = Ctx { psv, initial };
        let (mx, my) = f.mcus(1);
        let mut starts = vec![LineStart { row: 0, col: 0 }; scan.comps.len()];
        for m in 0..mx * my {
            let (mxi, myi) = (m % mx, m / mx);
            if ri > 0 && m > 0 && m % ri == 0 {
                r.restart();
                for (k, sc) in scan.comps.iter().enumerate() {
                    let c = &f.comps[sc.index];
                    starts[k] = LineStart { row: myi * c.v, col: mxi * c.h };
                }
            }
            for (k, sc) in scan.comps.iter().enumerate() {
                let c = &f.comps[sc.index];
                let p = &mut self.planes[sc.index];
                for v in 0..c.v {
                    for h in 0..c.h {
                        ctx.sample(r, tabs[k], p, mxi * c.h + h, myi * c.v + v, starts[k])?;
                    }
                }
            }
        }
        Ok(())
    }

    /// `photometric` is the dataset's label. Lossless JPEG has no colour transform of its own, so
    /// samples are returned as stored and the CLI converts a YBR label, with one exception: a
    /// subsampled YBR label (YBR_FULL_422, YBR_PARTIAL_422/420) on a codestream whose components
    /// all have the same sampling contradicts the codestream; the samples are then returned as
    /// RGB, unconverted (ruling in jpeg-lossless FORMAT.md, `ext-gdcm-JPEGLosslessYBR_FULL_422`).
    pub(crate) fn finish(self, f: &Frame, bps: usize, photometric: Photometric) -> Result<Image> {
        let (w, h) = (f.width, f.height);
        let n = f.comps.len();
        if bps == 1 && f.precision > 8 {
            return Err(invalid("JPEG precision exceeds Bits Allocated 8"));
        }
        let mut sink = Sink::new(w, h, n, bps)?;
        let mut rows: Vec<Vec<u16>> = vec![vec![0u16; w]; n];
        for y in 0..h {
            for ((ci, p), row) in self.planes.iter().enumerate().zip(rows.iter_mut()) {
                let c = &f.comps[ci];
                // Lossless frames with subsampled components are rare; replicate samples.
                let (hf, vf) = ((f.hmax / c.h).max(1), (f.vmax / c.v).max(1));
                let (cw, ch) = f.comp_size(ci);
                let sy = (y / vf).min(ch - 1);
                let src = &p.data[sy * p.stride..sy * p.stride + cw];
                let pt = u32::from(p.pt);
                if hf == 1 {
                    for (o, &v) in row.iter_mut().zip(src) {
                        *o = ((u32::from(v) << pt) & 0xFFFF) as u16;
                    }
                } else {
                    for (x, o) in row.iter_mut().enumerate() {
                        let v = src[(x / hf).min(cw - 1)];
                        *o = ((u32::from(v) << pt) & 0xFFFF) as u16;
                    }
                }
            }
            if n == 1 {
                put_row(&rows[0], sink.row(y), bps);
            } else {
                let srcs: Vec<&[u16]> = rows.iter().map(|r| &r[..]).collect();
                interleave_row(&srcs, sink.row(y), bps);
            }
        }
        let same_sampling = f.comps.iter().all(|c| c.h == f.comps[0].h && c.v == f.comps[0].v);
        let subsampled_label = matches!(
            photometric,
            Photometric::YbrFull422 | Photometric::YbrPartial422 | Photometric::YbrPartial420
        );
        let rgb = n == 3 && same_sampling && subsampled_label;
        Ok(Image { width: w, height: h, components: n, data: sink.into_data(), rgb, retry_cornell: self.bad_codes > 0 && self.saw_ssss16 && !self.cornell, bad_codes: self.bad_codes })
    }
}

/// Decode the difference for one sample (H.1.2.2): SSSS 0–15 is followed by SSSS bits, and
/// SSSS 16 means 32768 with no extra bits (16 junk bits under the Cornell workaround). A code
/// that matches no table entry is read as libjpeg's `jpeg_huff_decode` reads it: it has then
/// read 17 bits (its `maxcode[17]` sentinel ends the search), warns `JWRN_HUFF_BAD_CODE` and
/// returns symbol 0, so the difference is 0. dcmtk and GDCM decode past such codes this way (see
/// jpeg-lossless FORMAT.md).
/// `b` is the reader's bit buffer, held by the caller (`BitReader::load`/`store`).
#[inline(always)]
fn diff_b(r: &mut BitReader, b: &mut Bits, t: &HuffTable) -> Result<i32> {
    // 32 bits cover a code (<= 16 bits) and its value bits (<= 16).
    *b = r.ensure32(*b);
    let peek = b.peek();
    let f = t.fast[peek];
    if f != 0 {
        b.consume((f & 0xFF) as u32);
        return Ok(f >> 8);
    }
    let e = t.lookup[peek];
    let ssss = if e != 0 {
        b.consume(u32::from(e >> 8));
        u32::from(e & 0xFF)
    } else {
        match b.huff_long(t) {
            Ok((nb, s)) => {
                *b = nb;
                u32::from(s)
            }
            Err(_) if b.no_code_matches(t) => {
                r.bad_codes += 1;
                b.consume(17);
                0
            }
            Err(e) => return Err(e),
        }
    };
    match ssss {
        0..=15 => Ok(extend(b.take(ssss), ssss)),
        16 => {
            r.ssss16 = true;
            if r.cornell {
                b.consume(16);
            }
            Ok(32768)
        }
        _ => Err(invalid("lossless difference category > 16")),
    }
}

/// `diff_b` for callers that do not hold the bit buffer.
#[inline]
fn diff(r: &mut BitReader, t: &HuffTable) -> Result<i32> {
    let mut b = r.load();
    let d = diff_b(r, &mut b, t);
    r.store(b);
    d
}

/// Predictor `psv` (H.1.2.1, table H.1) from left (a), above (b) and above-left (c).
#[inline(always)]
fn predict(psv: u8, ra: i32, rb: i32, rc: i32) -> i32 {
    match psv {
        1 => ra,
        2 => rb,
        3 => rc,
        4 => ra + rb - rc,
        5 => ra + ((rb - rc) >> 1),
        6 => rb + ((ra - rc) >> 1),
        _ => (ra + rb) >> 1,
    }
}

/// Row-wise decoding of `planes` (in scan order, each `cw` × `ch` at its stride), samples
/// interleaved component by component. Each row is split at restart points. On the row where
/// the current restart interval began, samples from its start column on use the left neighbour
/// (the very first takes `initial`); on other rows column 0 uses the sample above and the rest use
/// the predictor.
#[allow(clippy::too_many_arguments)]
fn decode_rows(
    r: &mut BitReader,
    tabs: &[&HuffTable],
    planes: &mut [&mut Plane],
    cw: usize,
    ch: usize,
    ri: usize,
    psv: u8,
    initial: i32,
) -> Result<()> {
    let n = planes.len();
    let mut start = LineStart { row: 0, col: 0 };
    for y in 0..ch {
        // (previous row, current row) for each component.
        let mut lines: Vec<(&[u16], &mut [u16])> = Vec::with_capacity(n);
        for p in planes.iter_mut() {
            let st = p.stride;
            let (before, rest) = p.data.split_at_mut(y * st);
            let up: &[u16] = if y > 0 { &before[(y - 1) * st..(y - 1) * st + cw] } else { &[] };
            lines.push((up, &mut rest[..cw]));
        }
        let mut x = 0;
        while x < cw {
            let i = y * cw + x;
            if ri > 0 && i > 0 && i.is_multiple_of(ri) {
                r.restart();
                start = LineStart { row: y, col: x };
            }
            let end = if ri > 0 { cw.min(x + ri - i % ri) } else { cw };
            let mut b = r.load();
            let r = &mut *r;
            if y == start.row {
                for xx in x..end {
                    for (k, (_, cur)) in lines.iter_mut().enumerate() {
                        let pred = if xx == start.col { initial } else { i32::from(cur[xx - 1]) };
                        cur[xx] = (pred.wrapping_add(diff_b(r, &mut b, tabs[k])?) & 0xFFFF) as u16;
                    }
                }
            } else if n == 1 {
                let (up, cur) = &mut lines[0];
                let t = tabs[0];
                let mut xx = x;
                if xx == 0 {
                    cur[0] = (i32::from(up[0]).wrapping_add(diff_b(r, &mut b, t)?) & 0xFFFF) as u16;
                    xx = 1;
                }
                for xx in xx..end {
                    let pred = predict(psv, i32::from(cur[xx - 1]), i32::from(up[xx]), i32::from(up[xx - 1]));
                    cur[xx] = (pred.wrapping_add(diff_b(r, &mut b, t)?) & 0xFFFF) as u16;
                }
            } else {
                for xx in x..end {
                    for (k, (up, cur)) in lines.iter_mut().enumerate() {
                        let pred = if xx == 0 {
                            i32::from(up[0])
                        } else {
                            predict(psv, i32::from(cur[xx - 1]), i32::from(up[xx]), i32::from(up[xx - 1]))
                        };
                        cur[xx] = (pred.wrapping_add(diff_b(r, &mut b, tabs[k])?) & 0xFFFF) as u16;
                    }
                }
            }
            r.store(b);
            x = end;
        }
    }
    Ok(())
}

struct Ctx {
    psv: u8,
    initial: i32,
}

impl Ctx {
    #[inline]
    fn sample(&mut self, r: &mut BitReader, t: &HuffTable, p: &mut Plane, x: usize, y: usize, s: LineStart) -> Result<()> {
        let st = p.stride;
        // Neighbours left of column 0 or above row 0 are never used by a valid ordering; the
        // fallback of 0 only keeps index arithmetic panic-free.
        let at = |xx: Option<usize>, yy: Option<usize>| match (xx, yy) {
            (Some(xx), Some(yy)) => p.data.get(yy * st + xx).map_or(0, |&v| i32::from(v)),
            _ => 0,
        };
        let (left, up) = (x.checked_sub(1), y.checked_sub(1));
        let pred = if y == s.row && x == s.col {
            self.initial
        } else if y == s.row && x > s.col {
            at(left, Some(y))
        } else if x == 0 {
            at(Some(0), up)
        } else {
            predict(self.psv, at(left, Some(y)), at(Some(x), up), at(left, up))
        };
        let diff = diff(r, t)?;
        p.data[y * st + x] = (pred.wrapping_add(diff) & 0xFFFF) as u16;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markers::{Component, Process, ScanComp};

    #[test]
    fn bad_code_reads_17_bits_and_gives_zero() {
        // One code: '0' -> SSSS 1. Seventeen 1 bits match nothing: libjpeg reads all 17 and
        // returns symbol 0 (difference 0). Then '0' '1' decodes as +1.
        let mut counts = [0u8; 16];
        counts[0] = 1;
        let t = HuffTable::new(&counts, &[1], 0).unwrap();
        let d = [0xFF, 0x00, 0xFF, 0x00, 0xBF]; // 17 ones, 0, 1, then padding ones
        let mut r = BitReader::new(&d);
        assert_eq!(diff(&mut r, &t).unwrap(), 0);
        assert_eq!(r.bad_codes, 1);
        assert_eq!(diff(&mut r, &t).unwrap(), 1);
        assert_eq!(r.bad_codes, 1);
    }

    /// Encode a tiny image with one fixed Huffman table and check every predictor round-trips,
    /// including the SSSS=16 category and a restart interval that starts mid-row.
    #[test]
    fn predictors_round_trip() {
        let (w, h) = (5usize, 4usize);
        let img: Vec<u16> = vec![
            0, 65535, 32768, 1, 2, //
            100, 40000, 7, 8, 9, //
            65535, 0, 32768, 300, 3, //
            5, 5, 5, 60000, 0,
        ];
        // Table: 17 symbols (0..=16), each with a 5-bit code.
        let mut counts = [0u8; 16];
        counts[4] = 17;
        let vals: Vec<u8> = (0..=16).collect();
        let table = HuffTable::new(&counts, &vals, 0).unwrap();
        for psv in 1..=7u8 {
            for ri in [0usize, 7] {
                let mut bits = String::new();
                let mut start = LineStart { row: 0, col: 0 };
                let mut enc = vec![0u16; w * h];
                let mut bytes: Vec<u8> = Vec::new();
                let flush = |bits: &mut String, bytes: &mut Vec<u8>| {
                    while !bits.len().is_multiple_of(8) {
                        bits.push('1');
                    }
                    for i in (0..bits.len()).step_by(8) {
                        let b = u8::from_str_radix(&bits[i..i + 8], 2).unwrap();
                        bytes.push(b);
                        if b == 0xFF {
                            bytes.push(0);
                        }
                    }
                    bits.clear();
                };
                for y in 0..h {
                    for x in 0..w {
                        let i = y * w + x;
                        if ri > 0 && i > 0 && i % ri == 0 {
                            flush(&mut bits, &mut bytes);
                            bytes.extend_from_slice(&[0xFF, 0xD0 + ((i / ri - 1) % 8) as u8]);
                            start = LineStart { row: y, col: x };
                        }
                        let mut p = Plane { data: enc.clone(), stride: w, pt: 0 };
                        // Reuse the decoder's predictor by decoding a zero difference.
                        let zero = [0b0000_0111u8, 0xFF, 0];
                        let mut rr = BitReader::new(&zero);
                        let mut c = Ctx { psv, initial: 1 << 15 };
                        c.sample(&mut rr, &table, &mut p, x, y, start).unwrap();
                        let pred = i32::from(p.data[y * w + x]);
                        let diff = (i32::from(img[i]) - pred).rem_euclid(65536);
                        let d = if diff >= 32768 { diff - 65536 } else { diff };
                        let (ssss, extra) = if d == -32768 || d == 32768 {
                            (16u32, String::new())
                        } else if d == 0 {
                            (0, String::new())
                        } else {
                            let s = 32 - d.unsigned_abs().leading_zeros();
                            let v = if d < 0 { d + (1 << s) - 1 } else { d } as u32;
                            (s, format!("{:0width$b}", v, width = s as usize))
                        };
                        bits.push_str(&format!("{:05b}", ssss));
                        bits.push_str(&extra);
                        enc[i] = img[i];
                    }
                }
                flush(&mut bits, &mut bytes);
                let frame = Frame {
                    process: Process::Lossless,
                    precision: 16,
                    width: w,
                    height: h,
                    comps: vec![Component { id: 1, h: 1, v: 1, tq: 0 }],
                    hmax: 1,
                    vmax: 1,
                };
                let mut tables = Tables::default();
                tables.dc[0] = Some(table.clone());
                tables.restart_interval = ri;
                let scan = Scan { comps: vec![ScanComp { index: 0, td: 0, ta: 0 }], ss: psv, al: 0 };
                let mut dec = LosslessDecoder::new(&frame, false).unwrap();
                dec.decode_scan(&bytes, &scan, &tables, &frame).unwrap();
                let out = dec.finish(&frame, 2, Photometric::Monochrome2).unwrap();
                let got: Vec<u16> = out.data.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                assert_eq!(got, img, "psv {psv} ri {ri}");
            }
        }
    }
}
