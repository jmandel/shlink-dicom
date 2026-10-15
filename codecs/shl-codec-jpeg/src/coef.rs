//! Coefficient-buffered DCT decoding: progressive scans (Huffman or arithmetic), arithmetic
//! sequential scans, and every DCT frame of a hierarchical image. Each scan adds to a buffer of
//! quantised coefficients (16-bit, as libjpeg's `JCOEF`); the inverse DCT runs once all scans
//! are read (`DctDecoder::finish`, or `hier` for hierarchical frames).

use crate::arith::{self, ArithReader, DctStats};
use crate::bits::BitReader;
use crate::markers::{Frame, Scan, Tables};
use crate::{invalid, phuff};
use shl_codec_common::Result;

/// One component's quantised coefficients: `bw` × `bh` blocks of 64, natural order.
pub(crate) struct CoefPlane {
    pub(crate) data: Vec<i16>,
    pub(crate) bw: usize,
    pub(crate) bh: usize,
}

impl CoefPlane {
    pub(crate) fn block_mut(&mut self, bx: usize, by: usize) -> Option<&mut [i16; 64]> {
        if bx >= self.bw || by >= self.bh {
            return None;
        }
        let i = (by * self.bw + bx) * 64;
        self.data.get_mut(i..i + 64).and_then(|s| s.try_into().ok())
    }

    pub(crate) fn block(&self, bx: usize, by: usize) -> Option<&[i16; 64]> {
        if bx >= self.bw || by >= self.bh {
            return None;
        }
        let i = (by * self.bw + bx) * 64;
        self.data.get(i..i + 64).and_then(|s| s.try_into().ok())
    }
}

/// Coefficient planes for every component of `f`, covering whole MCUs.
pub(crate) fn planes(f: &Frame) -> Result<Vec<CoefPlane>> {
    let (mx, my) = f.mcus(8);
    f.comps
        .iter()
        .map(|c| {
            let (bw, bh) = (mx * c.h, my * c.v);
            let n = bw.checked_mul(bh).and_then(|n| n.checked_mul(64)).ok_or_else(|| invalid("image too large"))?;
            let mut data = Vec::new();
            data.try_reserve_exact(n).map_err(|_| invalid("image too large"))?;
            data.resize(n, 0);
            Ok(CoefPlane { data, bw, bh })
        })
        .collect()
}

/// Visit the blocks of a DCT scan in decoding order: (index of the component in the scan,
/// block x, block y, whether the block starts an MCU). Non-interleaved scans cover
/// ceil(component size / 8) blocks, one per MCU; interleaved scans cover whole MCUs.
fn scan_blocks(f: &Frame, scan: &Scan, mut each: impl FnMut(usize, usize, usize, bool) -> Result<()>) -> Result<()> {
    if scan.comps.len() == 1 {
        let (cw, ch) = f.comp_size(scan.comps[0].index);
        let (bw, bh) = (cw.div_ceil(8), ch.div_ceil(8));
        for i in 0..bw * bh {
            each(0, i % bw, i / bw, true)?;
        }
    } else {
        let (mx, my) = f.mcus(8);
        for m in 0..mx * my {
            let (bx0, by0) = (m % mx, m / mx);
            let mut first = true;
            for (k, sc) in scan.comps.iter().enumerate() {
                let c = &f.comps[sc.index];
                for v in 0..c.v {
                    for h in 0..c.h {
                        each(k, bx0 * c.h + h, by0 * c.v + v, first)?;
                        first = false;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Check a scan's spectral selection and successive approximation for the frame's process.
pub(crate) fn check_scan(f: &Frame, scan: &Scan) -> Result<()> {
    if !f.progressive {
        // Sequential: libjpeg only warns about Ss/Se/Ah/Al and decodes all 64 coefficients.
        return Ok(());
    }
    if scan.ss == 0 {
        if scan.se != 0 {
            return Err(invalid("progressive DC scan with Se > 0"));
        }
    } else if scan.se < scan.ss || scan.se > 63 || scan.comps.len() != 1 {
        return Err(invalid("bad progressive AC scan parameters"));
    }
    if scan.ah != 0 && scan.ah != scan.al + 1 {
        return Err(invalid("bad successive approximation (Ah must be Al + 1)"));
    }
    if scan.al > 13 {
        return Err(invalid("successive approximation Al > 13"));
    }
    Ok(())
}

/// Decode one scan of a coefficient-buffered DCT frame into `coefs`.
pub(crate) fn decode_scan(coefs: &mut [CoefPlane], data: &[u8], scan: &Scan, t: &Tables, f: &Frame) -> Result<()> {
    check_scan(f, scan)?;
    let ri = t.restart_interval;
    let mut mcu = 0usize;
    if f.arithmetic {
        let mut r = ArithReader::new(data);
        let mut stats = DctStats::new();
        stats.reset(scan, f.progressive);
        let mode = Mode::of(f, scan);
        scan_blocks(f, scan, |k, bx, by, starts_mcu| {
            if starts_mcu {
                if ri > 0 && mcu > 0 && mcu.is_multiple_of(ri) {
                    r.restart();
                    stats.reset(scan, f.progressive);
                }
                mcu += 1;
            }
            let sc = &scan.comps[k];
            let mut scratch = [0i16; 64];
            let blk = coefs.get_mut(sc.index).and_then(|p| p.block_mut(bx, by)).unwrap_or(&mut scratch);
            match mode {
                Mode::Sequential => arith::seq_block(&mut r, &mut stats, t, k, sc.td, sc.ta, f.differential, blk),
                Mode::DcFirst => arith::dc_first(&mut r, &mut stats, t, k, sc.td, scan.al, f.differential, blk),
                Mode::DcRefine => arith::dc_refine(&mut r, &mut stats, scan.al, blk),
                Mode::AcFirst => arith::ac_first(&mut r, &mut stats, t, sc.ta, scan, blk),
                Mode::AcRefine => arith::ac_refine(&mut r, &mut stats, sc.ta, scan, blk),
            }
            Ok(())
        })
    } else {
        let mut r = BitReader::new(data);
        let mut pred = [0i32; 4];
        let mut eobrun = 0u32;
        let mode = Mode::of(f, scan);
        let mut dcs = Vec::with_capacity(scan.comps.len());
        let mut acs = Vec::with_capacity(scan.comps.len());
        for sc in &scan.comps {
            dcs.push(if matches!(mode, Mode::Sequential | Mode::DcFirst) { Some(t.dc_table(sc.td)?) } else { None });
            acs.push(if matches!(mode, Mode::Sequential | Mode::AcFirst | Mode::AcRefine) { Some(t.ac_table(sc.ta)?) } else { None });
        }
        scan_blocks(f, scan, |k, bx, by, starts_mcu| {
            if starts_mcu {
                if ri > 0 && mcu > 0 && mcu.is_multiple_of(ri) {
                    r.restart();
                    pred = [0; 4];
                    eobrun = 0;
                }
                mcu += 1;
            }
            let sc = &scan.comps[k];
            let mut scratch = [0i16; 64];
            let blk = coefs.get_mut(sc.index).and_then(|p| p.block_mut(bx, by)).unwrap_or(&mut scratch);
            let (dc, ac) = (dcs[k], acs[k]);
            match (mode, dc, ac) {
                (Mode::Sequential, Some(dc), Some(ac)) => seq_block(&mut r, dc, ac, &mut pred[k], f.differential, blk),
                (Mode::DcFirst, Some(dc), _) => phuff::dc_first(&mut r, dc, &mut pred[k], scan.al, f.differential, blk),
                (Mode::DcRefine, _, _) => {
                    phuff::dc_refine(&mut r, scan.al, blk);
                    Ok(())
                }
                (Mode::AcFirst, _, Some(ac)) => phuff::ac_first(&mut r, ac, scan, &mut eobrun, blk),
                (Mode::AcRefine, _, Some(ac)) => phuff::ac_refine(&mut r, ac, scan, &mut eobrun, blk),
                _ => Err(invalid("scan uses an undefined Huffman table")),
            }
        })
    }
}

/// A sequential Huffman block into the coefficient buffer (hierarchical frames only; plain
/// sequential frames decode straight to samples in `dct`).
fn seq_block(
    r: &mut BitReader,
    dc: &crate::huffman::HuffTable,
    ac: &crate::huffman::HuffTable,
    pred: &mut i32,
    differential: bool,
    blk: &mut [i16; 64],
) -> Result<()> {
    *blk = [0; 64];
    phuff::dc_first(r, dc, pred, 0, differential, blk)?;
    let mut k = 1usize;
    while k < 64 {
        let rs = phuff::symbol(r, ac)?;
        let run = usize::from(rs >> 4);
        let s = u32::from(rs & 15);
        if s == 0 {
            if run == 15 {
                k += 16;
                continue;
            }
            break;
        }
        k += run;
        let v = crate::bits::extend(phuff::bits(r, s), s);
        blk[crate::markers::ZIGZAG[k.min(79)]] = v as i16;
        k += 1;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Mode {
    Sequential,
    DcFirst,
    DcRefine,
    AcFirst,
    AcRefine,
}

impl Mode {
    fn of(f: &Frame, scan: &Scan) -> Self {
        match (f.progressive, scan.ss == 0, scan.ah == 0) {
            (false, _, _) => Self::Sequential,
            (true, true, true) => Self::DcFirst,
            (true, true, false) => Self::DcRefine,
            (true, false, true) => Self::AcFirst,
            (true, false, false) => Self::AcRefine,
        }
    }
}
