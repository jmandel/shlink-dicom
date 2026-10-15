//! Progressive Huffman decoding (T.81 G.2; processes 6, 8, 10 and 12), as libjpeg-turbo's
//! `jdphuff.c`: DC first and refinement scans, AC first scans with end-of-band runs, and AC
//! refinement scans with correction bits.

use crate::bits::{extend, BitReader};
use crate::huffman::HuffTable;
use crate::markers::{Scan, ZIGZAG};
use shl_codec_common::Result;

/// One Huffman symbol.
#[inline]
pub(crate) fn symbol(r: &mut BitReader, t: &HuffTable) -> Result<u8> {
    let mut b = r.ensure32(r.load());
    let e = t.lookup[b.peek()];
    let s = if e != 0 {
        b.consume(u32::from(e >> 8));
        (e & 0xFF) as u8
    } else {
        let (nb, s) = b.huff_long(t)?;
        b = nb;
        s
    };
    r.store(b);
    Ok(s)
}

/// `n` (0..=16) raw bits.
#[inline]
pub(crate) fn bits(r: &mut BitReader, n: u32) -> u32 {
    let mut b = r.ensure32(r.load());
    let v = b.take(n);
    r.store(b);
    v
}

/// DC first scan, one block. `differential`: hierarchical differential frame (no prediction).
pub(crate) fn dc_first(r: &mut BitReader, t: &HuffTable, pred: &mut i32, al: u8, differential: bool, blk: &mut [i16; 64]) -> Result<()> {
    let s = u32::from(symbol(r, t)?);
    if s > 16 {
        return Err(crate::invalid("DC difference category > 16"));
    }
    let diff = extend(bits(r, s), s);
    let v = if differential {
        diff
    } else {
        *pred = pred.wrapping_add(diff);
        *pred
    };
    blk[0] = (v.wrapping_shl(u32::from(al))) as i16;
    Ok(())
}

/// DC refinement, one block.
pub(crate) fn dc_refine(r: &mut BitReader, al: u8, blk: &mut [i16; 64]) {
    if bits(r, 1) != 0 {
        blk[0] |= (1i32 << al) as i16;
    }
}

/// AC first scan, one block; `eobrun` carries the end-of-band run between blocks.
pub(crate) fn ac_first(r: &mut BitReader, t: &HuffTable, scan: &Scan, eobrun: &mut u32, blk: &mut [i16; 64]) -> Result<()> {
    if *eobrun > 0 {
        *eobrun -= 1;
        return Ok(());
    }
    let se = usize::from(scan.se);
    let mut k = usize::from(scan.ss);
    while k <= se {
        let rs = symbol(r, t)?;
        let run = u32::from(rs >> 4);
        let s = u32::from(rs & 15);
        if s != 0 {
            k += run as usize;
            let v = extend(bits(r, s), s);
            blk[ZIGZAG[k.min(79)]] = (v.wrapping_shl(u32::from(scan.al))) as i16;
        } else if run == 15 {
            k += 15;
        } else {
            *eobrun = 1 << run;
            if run != 0 {
                *eobrun += bits(r, run);
            }
            *eobrun -= 1;
            break;
        }
        k += 1;
    }
    Ok(())
}

/// AC refinement scan, one block.
pub(crate) fn ac_refine(r: &mut BitReader, t: &HuffTable, scan: &Scan, eobrun: &mut u32, blk: &mut [i16; 64]) -> Result<()> {
    let se = usize::from(scan.se);
    let p1 = (1i32 << scan.al) as i16;
    let m1 = ((-1i32) << scan.al) as i16;
    let mut k = usize::from(scan.ss);
    // Append a correction bit to an already-nonzero coefficient.
    let correct = |r: &mut BitReader, c: &mut i16| {
        if bits(r, 1) != 0 && (*c & p1) == 0 {
            *c = if *c >= 0 { c.wrapping_add(p1) } else { c.wrapping_add(m1) };
        }
    };
    if *eobrun == 0 {
        while k <= se {
            let rs = symbol(r, t)?;
            let mut run = i32::from(rs >> 4);
            let s = rs & 15;
            let mut value = 0i16;
            if s != 0 {
                // A new coefficient is always ±1 in this bit position (libjpeg only warns
                // when the size is not 1).
                value = if bits(r, 1) != 0 { p1 } else { m1 };
            } else if run != 15 {
                *eobrun = 1 << run;
                if run != 0 {
                    *eobrun += bits(r, run as u32);
                }
                break;
            }
            // Skip already-nonzero coefficients (correcting them) and `run` zero ones.
            while k <= se {
                let c = &mut blk[ZIGZAG[k]];
                if *c != 0 {
                    correct(r, c);
                } else {
                    run -= 1;
                    if run < 0 {
                        break;
                    }
                }
                k += 1;
            }
            if value != 0 {
                blk[ZIGZAG[k.min(79)]] = value;
            }
            k += 1;
        }
    }
    if *eobrun > 0 {
        while k <= se {
            let c = &mut blk[ZIGZAG[k]];
            if *c != 0 {
                correct(r, c);
            }
            k += 1;
        }
        *eobrun -= 1;
    }
    Ok(())
}
